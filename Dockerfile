FROM denoland/deno:2.3.1

WORKDIR /app

COPY deno.json deno.lock ./

RUN deno install --frozen

COPY . .

CMD ["run", "--allow-all", "health.ts"]
