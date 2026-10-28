interface ModelEnvironment {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  AI_GATEWAY_API_KEY: string;
  AI_GATEWAY_MODEL: string;
}

/** Una configuración parcial de OpenAI no debe enviar datos a otro proveedor. */
export function agentModelConnection(env: ModelEnvironment) {
  const placeholder = (value: string) => /^(tu[_ -]?clave|your[_ -]?(api[_ -]?)?key|<.*>)$/i.test(value.trim());
  if (env.OPENAI_API_KEY || env.OPENAI_MODEL) {
    return env.OPENAI_API_KEY && !placeholder(env.OPENAI_API_KEY) && env.OPENAI_MODEL ? { provider: "openai" as const, model: env.OPENAI_MODEL } : null;
  }
  return env.AI_GATEWAY_API_KEY && !placeholder(env.AI_GATEWAY_API_KEY) && env.AI_GATEWAY_MODEL
    ? { provider: "gateway" as const, model: env.AI_GATEWAY_MODEL } : null;
}
