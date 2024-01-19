FROM denoland/deno:1.39.4

WORKDIR /livesync-bridge

VOLUME /livesync-bridge/dat

COPY . /livesync-bridge/

RUN rm -R /livesync-bridge/dat

RUN chown deno:deno -R /livesync-bridge

USER deno

CMD ["deno", "run", "-A", "main.ts"]