import assert from "node:assert/strict";
import test from "node:test";
import { createGoalHandler, parseGoal, validateInput } from "../supabase/functions/personalize-goal/handler.ts";

const origin = "https://yahmed99.github.io";
const accountId = "b2e3cd88-7992-4d75-8b86-31911e192e1d";
const idea = { hobby: "drawing", minutes: 20, idea: "Sunflower", materials: "Pencil" };
const output = { status: "completed", output: [
    { type: "reasoning" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: " Sketch the large shapes. " }] }
] };

function request(body = idea, headers = {}, method = "POST") {
    return new Request("https://example.test/functions/v1/personalize-goal", {
        method,
        headers: { Origin: origin, Authorization: "Bearer user-token", "Content-Type": "application/json", ...headers },
        body: method === "POST" ? JSON.stringify(body) : undefined
    });
}

function setup({ auth, quota, provider, fetcher } = {}) {
    const calls = [];
    const handler = createGoalHandler({
        supabaseUrl: "https://example.test", anonKey: "test-public", serviceKey: "test-server",
        openAIKey: "test-provider", origins: [origin, "http://localhost:8000"]
    }, fetcher || (async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/auth/v1/user")) return auth ?? Response.json({ id: accountId });
        if (url.includes("/rpc/")) return quota ?? Response.json(0);
        return provider ?? Response.json(output);
    }));
    return { handler, calls };
}

test("validates all hobbies and rejects extra, oversized, or invalid fields", () => {
    for (const hobby of ["reading", "drawing", "journaling"]) {
        for (const minutes of [1, 180]) {
            assert.deepEqual(validateInput({ hobby, minutes, hint: " " }), { hobby, minutes });
        }
    }
    for (const patch of [{ notes: "private" }, { userId: accountId }, { hobby: "other" }, { minutes: 0 },
        { minutes: 181 }, { minutes: 3.5 }, { minutes: "20" }, { hint: "x".repeat(2001) }, { materials: null }]) {
        assert.equal(validateInput({ ...idea, ...patch }), null);
    }
});

test("parses only complete assistant text and rejects refusals and oversized output", () => {
    assert.equal(parseGoal(output), "Sketch the large shapes.");
    for (const bad of [
        { ...output, status: "incomplete" }, { status: "completed", output: [] },
        { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }] },
        { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(1201) }] }] }
    ]) assert.equal(parseGoal(bad), null);
});

test("restricts browser origins and rejects missing auth, unsupported methods, and oversized bodies", async () => {
    const { handler, calls } = setup();
    const preflight = await handler(request(undefined, { Origin: "http://localhost:8000" }, "OPTIONS"));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:8000");
    assert.equal((await handler(request(idea, { Origin: "https://wrong.test" }))).status, 403);
    assert.equal((await handler(request(idea, { Authorization: "" }))).status, 401);
    assert.equal((await handler(request(idea, {}, "GET"))).status, 405);
    assert.equal((await handler(request({ ...idea, idea: "x".repeat(200000) }))).status, 400);
    assert.equal(calls.length, 0);
});

test("invalid or anonymous sessions cannot reach quota or provider", async () => {
    for (const auth of [new Response(null, { status: 401 }), Response.json({ id: accountId, is_anonymous: true })]) {
        const { handler, calls } = setup({ auth });
        assert.equal((await handler(request())).status, 401);
        assert.equal(calls.length, 1);
    }
});

test("uses verified identity for quota and sends only explicit inputs to OpenAI", async () => {
    const { handler, calls } = setup();
    const input = { ...idea, hint: "Try an outline" };
    const response = await handler(request(input));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { goal: "Sketch the large shapes." });
    assert.deepEqual(JSON.parse(calls[1].options.body), { caller_id: accountId });
    assert.equal(calls[0].options.headers.Authorization, "Bearer user-token");
    assert.equal(calls[2].url, "https://api.openai.com/v1/responses");
    const payload = JSON.parse(calls[2].options.body);
    assert.equal(payload.store, false);
    assert.equal(payload.model, "gpt-6-luna");
    assert.deepEqual(JSON.parse(payload.input), input);
    assert.doesNotMatch(calls[2].options.body, new RegExp(accountId));
});

test("blocks paid requests during cooldown or quota outage", async () => {
    const first = setup({ quota: Response.json(10) });
    const blocked = await first.handler(request());
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "10");
    assert.equal(first.calls.length, 2);
    const second = setup({ quota: new Response(null, { status: 500 }) });
    assert.equal((await second.handler(request())).status, 503);
    assert.equal(second.calls.length, 2);
});

test("provider failures, malformed JSON, and incomplete responses return safe errors", async () => {
    for (const provider of [new Response(null, { status: 429 }), new Response(null, { status: 500 }),
        new Response("bad json"), Response.json({ status: "incomplete" })]) {
        const { handler, calls } = setup({ provider });
        const response = await handler(request());
        assert.equal(response.status, 502);
        assert.equal(calls.length, 3);
        assert.ok(["unavailable", "no_suggestion"].includes((await response.json()).code));
    }
});

test("times out a provider request without retrying it", async t => {
    const deadline = new AbortController();
    t.mock.method(AbortSignal, "timeout", () => deadline.signal);
    let calls = 0;
    const { handler } = setup({ fetcher: async url => {
        calls++;
        if (url.endsWith("/auth/v1/user")) return Response.json({ id: accountId });
        if (url.includes("/rpc/")) return Response.json(0);
        deadline.abort(new DOMException("Timed out", "TimeoutError"));
        deadline.signal.throwIfAborted();
    } });
    const response = await handler(request());
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { code: "timeout" });
    assert.equal(calls, 3);
});

test("accepts bounded continuing-project context and rejects nested extra fields", async () => {
    const recentGoals = [{ goal: "Outline the flower", note: "Choose a light direction", elapsedSeconds: 60 }];
    const project = { name: "Garden sketches", goalDraft: "Add shadows", elapsedSeconds: 60,
        completedGoalCount: 1, recentGoals };
    const input = { ...idea, hint: "x".repeat(2000), project };
    const { handler, calls } = setup();
    assert.equal((await handler(request(input))).status, 200);
    assert.deepEqual(JSON.parse(JSON.parse(calls[2].options.body).input), input);
    for (const invalid of [
        { ...project, photo: "private" },
        { ...project, recentGoals: [{ ...recentGoals[0], storage_path: "private" }] },
        { ...project, completedGoalCount: 9, recentGoals: Array(9).fill(recentGoals[0]) },
        { ...project, elapsedSeconds: -1 }
    ]) assert.equal(validateInput({ ...input, project: invalid }), null);
});
