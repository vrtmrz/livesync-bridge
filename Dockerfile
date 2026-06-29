FROM docker.io/denoland/deno:2.6.9

WORKDIR /app
RUN chown deno:deno /app

USER deno

VOLUME /app/dat
VOLUME /app/data

COPY --chown=deno:deno . .

# Deno 2.x: install project deps from deno.jsonc (no permission flags here;
# runtime CMD `deno task run` applies -A). Fallback to cache for full prefetch.
RUN deno install || true
RUN deno cache main.ts

CMD [ "deno", "task", "run" ]
