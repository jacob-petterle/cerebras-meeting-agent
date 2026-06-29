FROM ubuntu:24.04 AS base

SHELL ["/bin/bash", "-c"]

ENV project=meeting-sdk-linux-sample
ENV cwd=/tmp/$project

WORKDIR $cwd

ARG DEBIAN_FRONTEND=noninteractive

#  Install Dependencies
RUN apt-get update  \
    && apt-get install -y \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    gdb \
    git \
    gfortran \
    libopencv-dev \
    libdbus-1-3 \
    libgbm1 \
    libgl1 \
    libglib2.0-0 \
    libglib2.0-dev \
    libssl-dev \
    libx11-dev \
    libx11-xcb1 \
    libxext-dev \
    libxcb-image0 \
    libxcb-keysyms1 \
    libxcb-randr0 \
    libxcb-shape0 \
    libxcb-shm0 \
    libxcb-xfixes0 \
    libxcb-xtest0 \
    libgl1-mesa-dri \
    libxfixes3 \
    libssl-dev \
    linux-libc-dev \
    pciutils \
    pkgconf \
    tar \
    unzip \
    zip

# Install ALSA
RUN apt-get install -y libasound2t64 libasound2-plugins alsa alsa-utils alsa-oss

# Install Pulseaudio
RUN apt-get install -y  pulseaudio pulseaudio-utils

# Stage-page screen share: a virtual X display (Xvfb) for a headed Chromium to
# draw on, the X utils we poll for readiness, the Xext dev package for the XShm
# capture path, and fonts so rendered text/emoji aren't tofu.
RUN apt-get install -y \
    xvfb \
    x11-utils \
    fonts-liberation \
    fonts-noto-color-emoji

# Install Google Chrome (google-chrome-stable) from Google's own apt repo.
# NOTE: do NOT use Ubuntu's `chromium` — on 24.04 it's a transitional package
# that pulls the Chromium *snap*, which does not run inside Docker. Google ships
# amd64 only, which is fine: this image is pinned linux/amd64 (Rosetta on Apple
# Silicon) because the Meeting SDK is x86_64-only.
RUN apt-get install -y gnupg \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable

FROM base AS deps

ENV TINI_VERSION=v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini

WORKDIR /opt
RUN git clone --depth 1 https://github.com/Microsoft/vcpkg.git \
    && ./vcpkg/bootstrap-vcpkg.sh -disableMetrics \
    && ln -s /opt/vcpkg/vcpkg /usr/local/bin/vcpkg \
    && vcpkg install vcpkg-cmake

FROM deps AS build

WORKDIR $cwd
ENTRYPOINT ["/tini", "--", "./bin/entry.sh"]


