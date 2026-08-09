FROM docker.io/denoland/deno:2.6.9

ARG APP_UID=1000
ARG APP_GID=1000

WORKDIR /app

# Match the common host user by default so bind-mounted vaults are writable
# without running the bridge as root. Set both IDs to 0 to opt in to root for
# vaults that contain root-owned files. Mixed root/non-root IDs are rejected.
RUN if [ "${APP_UID}" = "0" ] || [ "${APP_GID}" = "0" ]; then \
      if [ "${APP_UID}" != "0" ] || [ "${APP_GID}" != "0" ]; then \
        echo "APP_UID and APP_GID must both be 0 to run as root" >&2; \
        exit 1; \
      fi; \
    else \
      groupmod --gid "${APP_GID}" deno; \
      usermod --uid "${APP_UID}" --gid "${APP_GID}" deno; \
    fi \
  && mkdir -p /app/dat /app/data \
  && chown -R "${APP_UID}:${APP_GID}" /app /deno-dir

USER ${APP_UID}:${APP_GID}

VOLUME /app/dat
VOLUME /app/data

COPY --chown=${APP_UID}:${APP_GID} . .

# Deno 2.x: install the exact dependencies recorded in deno.lock. Runtime
# permissions remain attached to `deno task run` rather than the install step.
RUN deno install --frozen

CMD [ "deno", "task", "run" ]
