FROM denoland/deno:2.3.1

WORKDIR /app

VOLUME /app/dat

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

RUN rm -rf lib && git clone https://github.com/aotsukiqx/livesync-commonlib lib && \
    cd lib && git checkout 798a313

RUN mkdir -p /app/vault /app/vault-linux

COPY . .

CMD ["deno", "run", "--unstable-kv", "-A", "main.ts"]

