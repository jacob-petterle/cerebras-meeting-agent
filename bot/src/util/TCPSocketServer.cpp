#include "TCPSocketServer.h"

#include <arpa/inet.h>
#include <cstring>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <sstream>

TCPSocketServer::TCPSocketServer(int port, DataHandler handler)
    : m_port(port), m_handler(move(handler)) {}

TCPSocketServer::~TCPSocketServer() {
    stop();
}

bool TCPSocketServer::start() {
    if (m_running.exchange(true)) {
        Log::error("TCP audio server already running");
        return false;
    }
    m_thread = thread(&TCPSocketServer::run, this);
    return true;
}

void TCPSocketServer::run() {
    int listenfd = socket(AF_INET, SOCK_STREAM, 0);
    if (listenfd == -1) {
        Log::error("unable to create TCP listen socket");
        m_running = false;
        return;
    }

    int opt = 1;
    setsockopt(listenfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(static_cast<uint16_t>(m_port));

    if (bind(listenfd, (struct sockaddr*)&addr, sizeof(addr)) == -1) {
        Log::error("unable to bind TCP audio socket");
        close(listenfd);
        m_running = false;
        return;
    }

    if (listen(listenfd, 1) == -1) {
        Log::error("unable to listen on TCP audio socket");
        close(listenfd);
        m_running = false;
        return;
    }

    // Publish the listen fd so stop() can shut it down to unblock accept().
    {
        lock_guard<mutex> lock(m_sockMutex);
        m_listenSocket = listenfd;
    }

    {
        stringstream ss;
        ss << "TTS audio ingestion listening on TCP port " << m_port;
        Log::info(ss.str());
    }

    char buffer[4096];
    bool          hasCarry = false;   // odd-byte carry across reads (2-byte alignment)
    unsigned char carry    = 0;

    while (m_running) {
        int datafd = accept(listenfd, nullptr, nullptr);
        if (datafd == -1) {
            if (m_running)
                Log::error("failed to accept TCP audio connection");
            break;
        }
        {
            lock_guard<mutex> lock(m_sockMutex);
            m_dataSocket = datafd;
        }

        Log::success("TTS audio producer connected");
        hasCarry = false;

        // Drain this connection until it closes, then go back to accept().
        while (m_running) {
            auto n = read(datafd, buffer, sizeof(buffer));
            if (n <= 0) {
                Log::info("TTS audio producer disconnected");
                break;
            }

            // Reassemble a 2-byte-sample-aligned chunk: prepend any carried
            // byte, hold back a new trailing byte if the total is odd.
            char     chunk[sizeof(buffer) + 1];
            size_t   total = 0;
            if (hasCarry) {
                chunk[total++] = static_cast<char>(carry);
                hasCarry = false;
            }
            memcpy(chunk + total, buffer, static_cast<size_t>(n));
            total += static_cast<size_t>(n);

            if (total % 2 != 0) {
                carry = static_cast<unsigned char>(chunk[total - 1]);
                hasCarry = true;
                --total;
            }

            if (total > 0 && m_handler)
                m_handler(chunk, total);
        }

        closeDataSocket();
    }

    // Close the listen socket under the lock (stop() may also try).
    {
        lock_guard<mutex> lock(m_sockMutex);
        if (m_listenSocket != -1) {
            close(m_listenSocket);
            m_listenSocket = -1;
        }
    }
}

void TCPSocketServer::closeDataSocket() {
    lock_guard<mutex> lock(m_sockMutex);
    if (m_dataSocket != -1) {
        shutdown(m_dataSocket, SHUT_RDWR);
        close(m_dataSocket);
        m_dataSocket = -1;
    }
}

void TCPSocketServer::stop() {
    bool wasRunning = m_running.exchange(false);

    // Closing the sockets unblocks accept()/read() in the worker thread. All fd
    // access is under m_sockMutex so this can't double-close a reused fd.
    closeDataSocket();
    {
        lock_guard<mutex> lock(m_sockMutex);
        if (m_listenSocket != -1) {
            shutdown(m_listenSocket, SHUT_RDWR);
            close(m_listenSocket);
            m_listenSocket = -1;
        }
    }

    // Always join if the thread is still joinable — even if run() already
    // cleared m_running itself (e.g. a bind failure). Skipping the join would
    // leave a joinable std::thread, whose destructor calls std::terminate().
    if (m_thread.joinable())
        m_thread.join();

    if (wasRunning)
        Log::info("stopped TCP audio server");
}
