import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(new URL("../script.js", import.meta.url), "utf8");
const personalization = script.slice(script.indexOf("function resetPersonalization("), script.indexOf("function checkpointGoal("));

function setup() {
    const nodes = new Map();
    const calls = [];
    const field = id => {
        if (!nodes.has(id)) nodes.set(id, {
            hidden: false, disabled: false, value: "", textContent: "",
            focus() {}, addEventListener() {}, querySelector: () => field("submit")
        });
        return nodes.get(id);
    };
    const owner = { id: "account-a" };
    const context = vm.createContext({
        $: field, AbortController, AbortSignal, Response, personalizationRequest: null,
        window: { SUPABASE_CONFIG: { url: "https://example.test/", anonKey: "public-test" } },
        user: owner,
        client: { auth: { getSession: async () => ({ data: { session: { user: owner, access_token: "user-token" } } }) } },
        draft: { hobby: "reading", minutes: 20, idea: "A book", note: "Private note", photo: "Private photo" },
        checkpointGoal() {},
        fetch: (url, options) => new Promise(resolve => calls.push({ url, options, resolve }))
    });
    vm.runInContext(personalization, context);
    context.resetPersonalization();
    field("goal").value = "My existing goal";
    return { field, calls, context };
}

test("guests keep the local goal without a network request", async () => {
    const { field, calls, context } = setup();
    context.user = null;
    await field("personalize-goal").onclick();
    assert.equal(calls.length, 0);
    assert.equal(field("goal").value, "My existing goal");
});

test("preview is explicit and duplicate clicks do not send more requests", async () => {
    const { field, calls } = setup();
    const ready = field("personalize-goal").onclick();
    await field("personalize-goal").onclick();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        hobby: "reading", minutes: 20, idea: "A book", materials: ""
    });
    field("goal").value = "Edited while waiting";
    calls[0].resolve(Response.json({ goal: "Read the first few pages." }));
    await ready;
    assert.equal(field("goal").value, "Edited while waiting");
    assert.equal(field("personalization-preview").hidden, false);
    field("use-personalization").onclick();
    assert.equal(field("goal").value, "Read the first few pages.");
});

test("canceled or invalidated requests cannot render a stale preview", async () => {
    const { field, calls, context } = setup();
    const pending = field("personalize-goal").onclick();
    await new Promise(resolve => setImmediate(resolve));
    context.resetPersonalization();
    assert.equal(calls[0].options.signal.aborted, true);
    calls[0].resolve(Response.json({ goal: "Late response" }));
    await pending;
    assert.equal(field("personalization-preview").hidden, true);
    assert.equal(field("goal").value, "My existing goal");
});

test("continuing goals send progress and the editable hint without duplicating the latest saved note", async () => {
    const { field, calls, context } = setup();
    context.draft = {
        ...context.draft, nextGoal: true, projectName: "Reading project", note: "Start chapter four",
        elapsedSeconds: 720, taskHistory: [
            { goal: "Read chapter two", note: "Review the map", elapsedSeconds: 300, photo: "private" },
            { goal: "Read chapter three", note: "Start chapter four", elapsedSeconds: 420 }
        ]
    };
    field("next-goal-minutes").reportValidity = () => true;
    field("next-goal-minutes").valueAsNumber = 15;
    field("personalization-hint").value = "Review the chapter summary first";
    const pending = field("personalize-goal").onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        hobby: "reading", minutes: 15, idea: "A book", materials: "",
        hint: "Review the chapter summary first",
        project: {
            name: "Reading project", goalDraft: "My existing goal", elapsedSeconds: 720,
            completedGoalCount: 2, recentGoals: [
                { goal: "Read chapter two", note: "Review the map", elapsedSeconds: 300 },
                { goal: "Read chapter three", note: "", elapsedSeconds: 420 }
            ]
        }
    });
    calls[0].resolve(Response.json({ goal: "Read the summary first." }));
    await pending;
});
