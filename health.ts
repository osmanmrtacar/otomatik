const server = Deno.serve({ port: 8080 }, (_req) => {
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
});

async function sigIntHandler() {
  console.log("shutdown signal received");
  await server.shutdown();
  console.log("Server shutdown");

  Deno.exit();
}
Deno.addSignalListener("SIGINT", sigIntHandler);
