import interventionDesignHandler from "./api/intervention/design.js";

const readJsonBody = request =>
  new Promise((resolve, reject) => {
    let raw = "";

    request.setEncoding("utf8");

    request.on("data", chunk => {
      raw += chunk;

      if (raw.length > 2_000_000) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });

    request.on("error", reject);
  });

const nodeResponseAdapter = response => {
  const adapter = {
    status(code) {
      response.statusCode = code;
      return adapter;
    },

    setHeader(name, value) {
      response.setHeader(name, value);
      return adapter;
    },

    end(payload = "") {
      response.end(payload);
      return adapter;
    }
  };

  return adapter;
};

export const handleInterventionRoute = async (
  request,
  response
) => {
  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    response.statusCode = 400;
    response.setHeader(
      "Content-Type",
      "application/json; charset=utf-8"
    );
    response.end(JSON.stringify({
      error: "invalid intervention request",
      detail: String(error?.message || error)
    }));
    return;
  }

  try {
    await interventionDesignHandler(
      {
        method: request.method,
        headers: request.headers,
        body
      },
      nodeResponseAdapter(response)
    );
  } catch (error) {
    if (response.writableEnded) return;

    response.statusCode = 500;
    response.setHeader(
      "Content-Type",
      "application/json; charset=utf-8"
    );
    response.end(JSON.stringify({
      error: "intervention route failed",
      detail: String(error?.message || error)
    }));
  }
};
