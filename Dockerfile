FROM denoland/deno:2.3.1

WORKDIR /app

VOLUME /app/dat
VOLUME /app/data

COPY . .

# Deno 2.x: install project deps from deno.jsonc (no permission flags here;
# runtime CMD `deno task run` applies -A). Fallback to cache for full prefetch.
RUN deno install || true
RUN deno cache main.ts

CMD [ "deno", "task", "run" ]

