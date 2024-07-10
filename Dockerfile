FROM denoland/deno:1.44.4

WORKDIR /app

VOLUME /app/dat
VOLUME /app/data

COPY . .

RUN deno cache main.ts

CMD [ "deno", "run", "-A", "main.ts" ]

