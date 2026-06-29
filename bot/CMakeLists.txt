cmake_minimum_required(VERSION 3.22.1)
project(meeting_sdk_linux_sample VERSION 1.0.2)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_COMPILER /usr/bin/g++)

set(CMAKE_BUILD_TYPE Debug)
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(ZOOM_SDK lib/zoomsdk)

find_package(CLI11 REQUIRED)

find_path(PICOJSON_INCLUDE_DIRS "picojson/picojson.h")
find_path(JWT_CPP_INCLUDE_DIRS "jwt-cpp/base.h")

find_package(X11 REQUIRED)
include_directories(${X11_INCLUDE_DIR})
link_directories(${X11_LIBRARIES})

find_package(PkgConfig REQUIRED)
pkg_check_modules(deps REQUIRED IMPORTED_TARGET glib-2.0)

find_package( OpenCV REQUIRED )
include_directories( ${OpenCV_INCLUDE_DIRS} )

find_package(OpenSSL REQUIRED)

include_directories(${ZOOM_SDK}/h)
link_directories(${ZOOM_SDK} ${ZOOM_SDK})
link_directories(${ZOOM_SDK} ${ZOOM_SDK}/qt_libs/**)

add_executable(zoomsdk src/main.cpp
       src/Zoom.cpp
        src/Zoom.h
        src/Config.cpp
        src/Config.h
        src/util/Singleton.h
        src/util/Log.h
        src/events/AuthServiceEvent.cpp
        src/events/AuthServiceEvent.h
        src/events/MeetingServiceEvent.cpp
        src/events/MeetingServiceEvent.h
        src/events/MeetingReminderEvent.cpp
        src/events/MeetingReminderEvent.h
        src/events/MeetingRecordingCtrlEvent.cpp
        src/events/MeetingRecordingCtrlEvent.h
        src/events/MeetingShareCtrlEvent.cpp
        src/events/MeetingShareCtrlEvent.h
        src/raw_record/ZoomSDKAudioRawDataDelegate.cpp
        src/raw_record/ZoomSDKAudioRawDataDelegate.h
        src/raw_record/ZoomSDKRendererDelegate.cpp
        src/raw_record/ZoomSDKRendererDelegate.h
        src/raw_send/ZoomSDKVideoSource.h
        src/raw_send/ZoomSDKVideoSource.cpp
        src/raw_send/ZoomSDKShareSource.h
        src/raw_send/ZoomSDKShareSource.cpp
        src/raw_send/ZoomSDKVirtualAudioMicEvent.h
        src/raw_send/ZoomSDKVirtualAudioMicEvent.cpp
        src/util/SocketServer.h
        src/util/SocketServer.cpp
        src/util/TCPSocketServer.h
        src/util/TCPSocketServer.cpp
)

target_include_directories(zoomsdk PRIVATE ${JWT_CPP_INCLUDE_DIRS} ${PICOJSON_INCLUDE_DIRS})
# ${X11_Xext_LIB} provides libXext (XShm) for the stage-capture path; it's also
# usually pulled in by ${X11_LIBRARIES}, but list it explicitly to be safe.
target_link_libraries(zoomsdk PRIVATE meetingsdk OpenSSL::SSL OpenSSL::Crypto CLI11::CLI11 PkgConfig::deps ${OpenCV_LIBS} ${X11_LIBRARIES} ${X11_Xext_LIB})

# Standalone capture-proof tool (no Zoom SDK): grabs the Xvfb root via XShm and
# writes a PNG. See bin/entry.sh STAGE_SELFTEST.
add_executable(shmcap_test src/tools/shmcap_test.cpp)
target_link_libraries(shmcap_test PRIVATE ${OpenCV_LIBS} ${X11_LIBRARIES} ${X11_Xext_LIB})






