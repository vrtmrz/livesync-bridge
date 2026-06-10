FROM docker.io/denoland/deno:2.6.9

WORKDIR /app
RUN chown deno:deno /app

USER deno

VOLUME /app/dat
VOLUME /app/data

COPY --chown=deno:deno . .

RUN deno install --allow-import

CMD [ "deno", "task", "run" ]

