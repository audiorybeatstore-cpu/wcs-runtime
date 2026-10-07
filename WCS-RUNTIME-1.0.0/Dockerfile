FROM docker:dind

RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    git \
    nodejs \
    npm \
    python3 \
    py3-pip \
    py3-virtualenv

WORKDIR /workspace

# Cloudflare Containers do not support iptables/IP forwarding changes.
ENTRYPOINT ["sh", "-c", "dockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false --ip-forward=false > /var/log/dockerd.log 2>&1 & exec sleep infinity"]
