import { createGoalHandler } from "./handler.ts";

Deno.serve(createGoalHandler({
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    openAIKey: Deno.env.get("OPENAI_API_KEY"),
    origins: ["https://yahmed99.github.io", ...(Deno.env.get("GOAL_DEV_ORIGINS") || "")
        .split(",").map(origin => origin.trim()).filter(Boolean)]
}));
