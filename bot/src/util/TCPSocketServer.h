#ifndef MEETINGSDK_HEADLESS_LINUX_SAMPLE_TCPSOCKETSERVER_H
#define MEETINGSDK_HEADLESS_LINUX_SAMPLE_TCPSOCKETSERVER_H

#include <atomic>
#include <cstddef>
#include <functional>
#include <mutex>
#include <thread>

#include "Log.h"

using namespace std;

/**
 * Minimal AF_INET TCP server for ingesting raw PCM from the Mac host.
 *
 * The container LISTENS (publish the port with Docker `-p`); the Mac connects
 * in. We deliberately do NOT reuse the existing AF_UNIX SocketServer: Unix
 * domain sockets don't cross the Docker-for-Mac VM boundary
 * (TRANSPORT_CONTRACTS_RESEARCH.md). This is a reader, not a writer.
 *
 * Bytes are delivered to a handler in 2-byte-sample-aligned chunks (an odd
 * trailing byte is carried over to the next read), so downstream s16le framing
 * never splits a sample. Accept/read loops reconnect on client disconnect.
 */
class TCPSocketServer {
public:
    using DataHandler = function<void(const char*, size_t)>;

    TCPSocketServer(int port, DataHandler handler);
    ~TCPSocketServer();

    bool start();   // spawn the accept/read thread
    void stop();    // signal + join, close sockets

private:
    void run();

    int         m_port;
    DataHandler m_handler;

    thread       m_thread;
    atomic<bool> m_running{false};

    // Guards the socket fds, which are touched by both the worker thread (run)
    // and the caller thread (stop) — prevents a double-close / fd-reuse race.
    mutex m_sockMutex;
    int   m_listenSocket = -1;
    int   m_dataSocket   = -1;

    void closeDataSocket();    // close + reset m_dataSocket under m_sockMutex
};

#endif //MEETINGSDK_HEADLESS_LINUX_SAMPLE_TCPSOCKETSERVER_H
