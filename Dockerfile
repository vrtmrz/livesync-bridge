FROM docker.io/denoland/deno:2.6.9

ARG APP_UID=1000
ARG APP_GID=1000

WORKDIR /app

# Match the common host user by default so bind-mounted vaults are writable
# without running the bridge as root. Both IDs remain configurable at build time.
RUN groupmod --gid "${APP_GID}" deno \
  && usermod --uid "${APP_UID}" --gid "${APP_GID}" deno \
  && mkdir -p /app/dat /app/data \
  && chown -R deno:deno /app /deno-dir

USER deno

VOLUME /app/dat
VOLUME /app/data

COPY --chown=deno:deno . .

# Deno 2.x: install the exact dependencies recorded in deno.lock. Runtime
# permissions remain attached to `deno task run` rather than the install step.
RUN deno install --frozen

CMD [ "deno", "task", "run" ]
