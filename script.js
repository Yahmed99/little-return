"use strict";

const $ = id => document.getElementById(id);
const KEY = "little-return-v1";

const names = {
    drawing: "Drawing",
    reading: "Reading",
    journaling: "Journaling"
};

let state = { hobbies: [], sessions: [] };
let draft;
let activeId;
let blocked = false;
let client = null;
let user = null;
let cloudReady = false;
let generation = 0;
let saving = false;
let guestCount = 0;
let timerInterval = null;
let timerCheckpoint = null;
let timerWrites = 0;
const BUCKET = "progress-photos";
const emptyState = () => ({ hobbies: [], sessions: [] });
const cacheKey = () => user ? `${KEY}:user:${user.id}` : KEY;
const pending = () => state.sessions.filter(item => item.pending);

function accountUI() {
    $("auth-form").hidden = !!user;
    $("sign-out").hidden = !user;
    $("import-local").hidden = !user || !guestCount;
    $("sync-now").hidden = !user;
    $("sync-now").textContent = pending().length ? "Sync pending saves" : "Refresh cloud sessions";
    $("sign-in").disabled = !client;
    $("sync-status").textContent = user
        ? `${user.email} · ${pending().length ? `${pending().length} save(s) on this browser awaiting sync.` : cloudReady ? "Cloud connected." : "Cloud unavailable — using this account’s browser fallback."}`
        : "Local only — not synced to a cloud account.";
}

function readCache(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return emptyState();
        const data = JSON.parse(raw);
        if (!Array.isArray(data.hobbies) || !data.hobbies.every(h => Object.hasOwn(names, h)) ||
            !Array.isArray(data.sessions) || !data.sessions.every(item =>
                item && typeof item.id === "string" && Object.hasOwn(names, item.hobby) &&
                ["goal", "note", "materials", "idea"].every(k => typeof item[k] === "string") &&
                Number.isFinite(item.minutes) && Number.isFinite(item.updated) &&
                (!item.projectName || (typeof item.projectName === "string" && item.projectName.length <= 120)) &&
                (!item.taskHistory || (Array.isArray(item.taskHistory) && item.taskHistory.every(task =>
                    task && typeof task.goal === "string" && typeof task.completedAt === "string"))) &&
                (!item.elapsedSeconds || (Number.isFinite(item.elapsedSeconds) && item.elapsedSeconds >= 0)) &&
                (!item.completedAt || typeof item.completedAt === "string") &&
                (!item.photo || /^data:image\/(jpeg|png|webp);base64,/.test(item.photo)))) {
            throw new Error("Invalid browser data");
        }
        return {
            ...data,
            sessions: data.sessions.map(item => ({
                ...item,
                projectName: item.projectName || "",
                taskHistory: item.taskHistory || [],
                elapsedSeconds: item.elapsedSeconds || 0,
                goalCompleted: !!item.goalCompleted,
                completedAt: item.completedAt || null
            }))
        };
    } catch {
        blocked = true;
        say("Browser fallback could not be loaded. It has not been overwritten. Cloud saves can still be used; check browser storage before saving locally.", true);
        return emptyState();
    }
}

function writeCache(next) {
    if (blocked) return false;
    try {
        localStorage.setItem(cacheKey(), JSON.stringify(next));
        return true;
    } catch { return false; }
}

function fromRow(row) {
    return {
        ...row,
        photo: "",
        updated: Date.parse(row.updated_at),
        projectName: row.project_name || "",
        taskHistory: row.task_history || [],
        elapsedSeconds: row.elapsed_seconds || 0,
        goalCompleted: !!row.goal_completed,
        completedAt: row.completed_at || null,
        pending: false
    };
}

function inferHobbies() {
    state.hobbies = [...new Set([...state.hobbies, ...state.sessions.map(s => s.hobby)])];
    // A new cloud account can start immediately on any device.
    if (user && !state.hobbies.length) state.hobbies = Object.keys(names);
}

function landing() {
    inferHobbies();
    state.hobbies.length ? home() : setup();
    accountUI();
}

async function loadCloud() {
    const owner = user;
    const epoch = generation;
    if (!owner) return;
    try {
        // Page explicitly: Supabase normally caps each response at 1,000 rows.
        let rows = [];
        for (let start = 0; ; start += 500) {
            const { data, error } = await client.from("sessions").select("*")
                .eq("user_id", owner.id).order("id").range(start, start + 499);
            if (error) throw error;
            rows.push(...data);
            if (data.length < 500) break;
        }
        if (epoch !== generation) return;
        const waiting = pending();
        state.sessions = [...rows.filter(r => !waiting.some(p => p.id === r.id)).map(fromRow), ...waiting];
        cloudReady = true;
        inferHobbies();
        writeCache(state);
    } catch (error) {
        if (epoch !== generation) return;
        cloudReady = false;
        say(`Could not load cloud sessions: ${error.message}. Browser fallback remains available.`, true);
    }
    accountUI();
}

async function uploadPhoto(session, owner) {
    if (!session.photo) return session.storage_path || null;
    const blob = await (await fetch(session.photo)).blob();
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[blob.type];
    if (!extension || blob.size > 1024 * 1024) throw new Error("Invalid progress photo");
    const path = `${owner.id}/${session.id}/${crypto.randomUUID()}.${extension}`;
    const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw error;
    return path;
}

async function persistCloud(session, owner) {
    const path = await uploadPhoto(session, owner);
    const row = {
        id: session.id, user_id: owner.id, hobby: session.hobby, minutes: session.minutes,
        materials: session.materials, idea: session.idea, project_name: session.projectName || "",
        goal: session.goal, note: session.note,
        storage_path: path, created_at: session.created_at || new Date(session.updated).toISOString(),
        task_history: session.taskHistory || [], elapsed_seconds: session.elapsedSeconds || 0,
        goal_completed: !!session.goalCompleted, completed_at: session.completedAt || null
    };
    const { data, error } = await client.from("sessions").upsert(row).select().single();
    // If a response is lost, keep the upload: the database may already reference it.
    if (error) throw error;
    if (session.storage_path && session.storage_path !== path) {
        await client.storage.from(BUCKET).remove([session.storage_path]).catch(() => {});
    }
    return fromRow(data);
}

async function saveSession(session) {
    if (saving) return false;
    saving = true;
    const owner = user;
    const epoch = generation;
    try {
        let saved = { ...session, pending: !!owner };
        if (owner) {
            try {
                saved = await persistCloud(session, owner);
                if (epoch !== generation) return false;
                cloudReady = true;
            } catch (error) {
                if (epoch !== generation) return false;
                cloudReady = false;
                const next = { ...state, sessions: [...state.sessions.filter(s => s.id !== session.id), saved] };
                if (!writeCache(next)) {
                    say(`Cloud save failed: ${error.message}. Browser fallback also failed. Your changes remain on this screen; copy your notes or try again.`, true);
                    return false;
                }
                state = next;
                say(`Cloud save failed: ${error.message}. Saved only on this browser. Use Sync pending saves to retry.`, true);
                return "local";
            }
        }
        if (epoch !== generation) return false;
        const next = { ...state, sessions: [...state.sessions.filter(s => s.id !== session.id), saved] };
        const cached = writeCache(next);
        if (!owner && !cached) {
            say("Browser save failed. Storage may be blocked or full. Your changes remain on this screen; try removing the photo.", true);
            return false;
        }
        state = next;
        if (!owner) guestCount = state.sessions.length;
        say(owner ? (cached ? "Saved to your cloud account." : "Saved to cloud. Browser fallback is unavailable.") : "Saved on this browser only.");
        return true;
    } finally {
        saving = false;
        accountUI();
    }
}

function say(message = "", error = false) {
    $("status").textContent = error ? "" : message;
    $("error").textContent = error ? message : "";
}

function show(id) {
    for (const view of ["setup", "home", "goal-screen", "session", "goal-done"]) {
        $(view).hidden = view !== id;
    }

    $(id).querySelector("h1").focus();
}

function commit(next) {
    state = next;
    if (!writeCache(next)) {
        say("Hobbies changed for this visit. Browser preferences could not be saved.", true);
        return false;
    }
    return true;
}

function setup() {
    document.querySelectorAll('[name="hobbies"]').forEach(input => {
        input.checked = state.hobbies.includes(input.value);
    });

    $("cancel-setup").hidden = !state.hobbies.length;
    show("setup");
}

function home() {
    $("hobby").replaceChildren(
        ...state.hobbies.map(hobby => new Option(names[hobby], hobby))
    );

    $("saved").replaceChildren();

    const sessions = [...state.sessions].sort(
        (a, b) => b.updated - a.updated
    );

    for (const session of sessions.filter(item => !item.completedAt)) {
        const card = document.createElement("article");
        card.className = "card";

        const title = document.createElement("h2");
        title.textContent =
        session.projectName || session.idea || `${names[session.hobby]} in progress`;

        const note = document.createElement("p");
        note.className = "preserve";
        note.textContent = session.note || session.goal;

        const time = document.createElement("p");
        time.className = "hint project-time";
        time.textContent = `${formatTime(session.elapsedSeconds)} tracked · ${session.taskHistory.length} goal${session.taskHistory.length === 1 ? "" : "s"} completed`;

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = session.goalCompleted ? "Choose what’s next" : `Continue ${session.hobby}`;

        button.onclick = () => {
            say();
            openSession(session.id);
        };

        card.append(title, note, time, button);
        $("saved").append(card);
    }
    $("saved-empty").hidden = sessions.some(item => !item.completedAt);

    renderCompletedProjects(sessions.filter(item => item.completedAt));

    show("home");
}

function formatTime(seconds = 0) {
    if (seconds < 60) return `${seconds}s`;
    const totalMinutes = Math.floor(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours ? `${hours}h ${minutes}m` : `${totalMinutes}m`;
}

function renderCompletedProjects(projects) {
    const gallery = $("completed-projects");
    gallery.replaceChildren();
    for (const project of projects) {
        const card = document.createElement("article");
        card.className = "card completed-card";
        const title = document.createElement("h3");
        title.textContent = project.projectName || project.idea || `${names[project.hobby]} project`;
        const meta = document.createElement("p");
        meta.className = "hint";
        meta.textContent = `${names[project.hobby]} · ${formatTime(project.elapsedSeconds)} · Completed ${new Date(project.completedAt).toLocaleDateString()}`;
        const goals = document.createElement("ol");
        for (const task of project.taskHistory) {
            const item = document.createElement("li");
            item.textContent = task.goal;
            goals.append(item);
        }
        card.append(title, meta);
        if (goals.childElementCount) card.append(goals);
        if (project.note) {
            const note = document.createElement("p");
            note.className = "preserve";
            note.textContent = project.note;
            card.append(note);
        }
        gallery.append(card);
    }
    $("completed-empty").hidden = projects.length > 0;
}

function updateTimerLabel() {
    const session = state.sessions.find(item => item.id === activeId);
    $("timer").textContent = session ? `${formatTime(session.elapsedSeconds)} tracked` : "";
}

function tickTimer(persist = false) {
    if (!activeId || timerCheckpoint === null) return;
    const now = Date.now();
    const seconds = Math.floor((now - timerCheckpoint) / 1000);
    if (!seconds) return;
    timerCheckpoint += seconds * 1000;
    state.sessions = state.sessions.map(item => item.id === activeId
        ? { ...item, elapsedSeconds: (item.elapsedSeconds || 0) + seconds, updated: now }
        : item);
    timerWrites += seconds;
    updateTimerLabel();
    if (persist || timerWrites >= 15) {
        writeCache(state);
        timerWrites = 0;
    }
}

function startTimer() {
    stopTimer();
    timerCheckpoint = Date.now();
    timerWrites = 0;
    timerInterval = setInterval(() => tickTimer(), 1000);
    updateTimerLabel();
}

function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    tickTimer(true);
    timerCheckpoint = null;
    timerWrites = 0;
    return state.sessions.find(item => item.id === activeId);
}

function recommend(hobby, minutes, materials, idea) {
    const available = materials.toLowerCase();

    if (hobby === "reading") {
        return (
            `Read ${idea || "a book or article you already have"} ` +
            `for about ${Math.max(1, minutes - 2)} minutes. ` +
            "Use any remaining time to mark your place and note one thought."
        );
    }

    if (hobby === "journaling") {
        const medium = /phone|tablet|laptop|digital/.test(available)
        ? "your notes app"
        : "paper or a notes app";

        const scope = minutes <= 5
        ? "A few words or one sentence is enough."
        : `Write freely for ${Math.max(1, minutes - 2)} minutes, ` +
        "then leave a sentence to return to.";

        return (
            `In ${medium}, write about ` +
            `${idea || "one small moment from today"}. ${scope}`
        );
    }

    const subject = idea || "a simple penguin made from two ovals";
    const digital = /tablet|ipad|digital|drawing app/.test(available);
    const surface = /paper|sketchbook|notebook|pad/.test(available);
    const tool = /pencil|pen|marker|crayon|charcoal|brush/.test(available);

    if (available.trim() && !digital && !(surface && tool)) {
        return (
            `Plan ${subject} for ${minutes} minutes: ` +
            "observe or imagine its largest shapes. " +
            "If you have a drawing surface and a drawing tool, sketch them; " +
            "otherwise make a mental composition to draw next time."
        );
    }

    const medium = digital
    ? "In your drawing app, "
    : available.trim()
    ? "With your available supplies, "
    : "If you have pencil and paper, ";

    let goal;

    if (minutes < 10) {
        goal = `sketch only the largest shapes of ${subject}.`;
    } else if (minutes <= 25) {
        goal =
        `sketch the outline of ${subject}. ` +
        "Start refining the line art if time allows.";
    } else {
        goal =
        `sketch the outline of ${subject}. ` +
        "Refine the lines and add a few details if time allows.";
    }

    return (
        medium + goal +
        " Leave color for another session; " +
        "an unfinished sketch is a good stopping point."
    );
}

$("setup-form").onsubmit = event => {
    event.preventDefault();

    const hobbies = [
        ...document.querySelectorAll('[name="hobbies"]:checked')
    ].map(input => input.value);

    if (!hobbies.length) {
        say("Choose at least one hobby.", true);
        return;
    }

    if (commit({ ...state, hobbies })) {
        home();
        say("Hobbies saved on this browser.");
    }
};

$("edit-hobbies").onclick = () => {
    say();
    setup();
};

$("cancel-setup").onclick = () => {
    say();
    home();
};

$("back").onclick = () => {
    say();
    home();
};

$("plan-form").onsubmit = event => {
    event.preventDefault();

    draft = {
        hobby: $("hobby").value,
        minutes: Number($("minutes").value),
        materials: $("materials").value.trim(),
        idea: $("idea").value.trim(),
        projectName: $("project-name").value.trim()
    };

    $("goal").value = recommend(
        draft.hobby,
        draft.minutes,
        draft.materials,
        draft.idea
    );

    $("goal-context").textContent =
    `${names[draft.hobby]} · ${draft.minutes} minutes` +
    (draft.materials ? ` · ${draft.materials}` : "");

    say();
    show("goal-screen");
};

$("goal-form").onsubmit = async event => {
    event.preventDefault();

    const goal = $("goal").value.trim();

    if (!goal) {
        say("Write a small goal before starting.", true);
        return;
    }

    const startingNewProject = !draft.id;
    const session = {
        ...draft,
        goal,
        id: draft.id || (draft.id = crypto.randomUUID()),
        note: draft.note || "",
        photo: draft.photo || "",
        taskHistory: draft.taskHistory || [],
        elapsedSeconds: draft.elapsedSeconds || 0,
        goalCompleted: false,
        completedAt: null,
        updated: Date.now()
    };

    const button = $("goal-form").querySelector('[type="submit"]');
    button.disabled = true;
    try {
        const result = await saveSession(session);
        if (result) {
            if (startingNewProject) $("plan-form").reset();
            await openSession(session.id, false);
        }
    } finally { button.disabled = false; }
};

async function openSession(id, refresh = true) {
    const epoch = generation;
    const owner = user;
    let session = state.sessions.find(item => item.id === id);
    if (!session) return;
    if (owner && refresh && !session.pending) {
        try {
            const { data, error } = await client.from("sessions").select("*").eq("id", id).eq("user_id", owner.id).single();
            if (error) throw error;
            if (epoch !== generation) return;
            session = fromRow(data);
            state.sessions = state.sessions.map(s => s.id === id ? session : s);
            writeCache(state);
        } catch (error) {
            if (epoch !== generation) return;
            say(`Could not refresh this session: ${error.message}. Showing the browser copy.`, true);
        }
    }
    if (epoch !== generation) return;
    activeId = id;
    if (session.goalCompleted) {
        showCompletionChoice(session);
        return;
    }
    $("active-goal").textContent = session.goal;
    $("session-meta").textContent = `${names[session.hobby]} · ${session.minutes}-minute goal` +
        (session.materials ? ` · ${session.materials}` : "");
    $("note").value = session.note;
    $("photo").value = "";
    $("remove-photo").checked = false;
    $("photo-controls").hidden = session.hobby === "reading";
    $("preview").hidden = true;
    $("preview").removeAttribute("src");
    $("remove-wrap").hidden = !(session.photo || session.storage_path);
    show("session");
    startTimer();
    let url = session.photo;
    if (!url && session.storage_path && owner) {
        try {
            const { data, error } = await client.storage.from(BUCKET).createSignedUrl(session.storage_path, 3600);
            if (error) throw error;
            url = data.signedUrl;
        } catch { say("Your photo could not be loaded. The saved photo is still attached; try opening this session again.", true); }
    }
    if (epoch === generation && activeId === id && !$("session").hidden && url) {
        $("preview").src = url;
        $("preview").hidden = false;
    }
}

function readPhoto(file) {
    return new Promise((resolve, reject) => {
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

        if (!allowedTypes.includes(file.type) || file.size > 1024 * 1024) {
            reject(new Error(
                "Choose a JPEG, PNG or WebP up to 1 MB, " +
                "or clear the photo selection to save without it."
            ));
            return;
        }

        const reader = new FileReader();

        reader.onerror = () => {
            reject(new Error(
                "The photo could not be read. " +
                "Choose it again or save without it."
            ));
        };

        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
}

function showCompletionChoice(project) {
    $("done-project-title").textContent = project.projectName || project.idea || `${names[project.hobby]} project`;
    $("done-task").textContent = project.goal;
    $("done-project-time").textContent = `${formatTime(project.elapsedSeconds)} tracked across this project.`;
    show("goal-done");
}

$("progress-form").onsubmit = async event => {
    event.preventDefault();

    const epoch = generation;
    const button = $("save-progress");
    button.disabled = true;
    $("leave").disabled = true;
    button.textContent = "Saving…";

    try {
        const session = state.sessions.find(item => item.id === activeId);
        const captured = await captureProgress(session);
        if (epoch !== generation) return;
        const timed = stopTimer();
        const updated = { ...timed, ...captured, updated: Date.now() };
        const result = await saveSession(updated);
        if (result) home();
        else startTimer();
    } catch (error) {
        say(error.message, true);
    } finally {
        button.disabled = false;
        $("leave").disabled = false;
        button.textContent = "Save progress & return home";
    }
};

async function captureProgress(session) {
    let photo = $("remove-photo").checked ? "" : session.photo;
    const file = $("photo").files[0];
    if (file && !$("remove-photo").checked) photo = await readPhoto(file);
    return {
        note: $("note").value.trim(),
        photo,
        storage_path: $("remove-photo").checked ? null : session.storage_path
    };
}

$("complete-task").onclick = async () => {
    const button = $("complete-task");
    button.disabled = true;
    try {
        const epoch = generation;
        const session = state.sessions.find(item => item.id === activeId);
        const captured = await captureProgress(session);
        if (epoch !== generation) return;
        const timed = stopTimer();
        const updated = {
            ...timed,
            ...captured,
            taskHistory: [...timed.taskHistory, { goal: timed.goal, completedAt: new Date().toISOString() }],
            goalCompleted: true,
            updated: Date.now()
        };
        const result = await saveSession(updated);
        if (!result) { startTimer(); return; }
        showCompletionChoice(updated);
    } catch (error) {
        say(error.message, true);
    } finally { button.disabled = false; }
};

$("continue-project").onclick = () => {
    const project = state.sessions.find(item => item.id === activeId);
    draft = {
        id: project.id,
        hobby: project.hobby,
        minutes: project.minutes,
        materials: project.materials,
        idea: project.idea,
        projectName: project.projectName,
        note: project.note,
        photo: project.photo,
        storage_path: project.storage_path,
        taskHistory: project.taskHistory,
        elapsedSeconds: project.elapsedSeconds
    };
    $("goal").value = recommend(draft.hobby, draft.minutes, draft.materials, draft.idea);
    $("goal-context").textContent = `${draft.projectName || draft.idea || names[draft.hobby]} · Next goal`;
    say();
    show("goal-screen");
};

$("finish-project").onclick = async () => {
    const button = $("finish-project");
    button.disabled = true;
    try {
        const project = state.sessions.find(item => item.id === activeId);
        const completed = { ...project, goalCompleted: true, completedAt: new Date().toISOString(), updated: Date.now() };
        const result = await saveSession(completed);
        if (result) {
            activeId = null;
            home();
            say("Project completed and added to your gallery.");
        }
    } finally { button.disabled = false; }
};

function hasUnsavedProgress() {
    if ($("session").hidden) return false;

    const session = state.sessions.find(item => item.id === activeId);
    if (!session) return false;

    return (
        $("note").value.trim() !== session.note ||
        $("photo").files.length > 0 ||
        $("remove-photo").checked
    );
}

$("leave").onclick = () => {
    if (
        hasUnsavedProgress() &&
        !confirm(
            "Leave without saving these changes? " +
            "Your previously saved progress will remain."
        )
    ) {
        return;
    }

    const updated = stopTimer();
    saveSession(updated).then(result => {
        if (result) { home(); say(); }
        else startTimer();
    });
};

window.addEventListener("beforeunload", event => {
    if (hasUnsavedProgress()) {
        event.preventDefault();
        event.returnValue = "";
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.hidden && timerCheckpoint !== null) {
        stopTimer();
    } else if (!document.hidden && activeId && !$("session").hidden && timerCheckpoint === null) {
        startTimer();
    }
});

window.addEventListener("pagehide", () => {
    if (timerCheckpoint !== null) stopTimer();
});

// Avoid overwriting another tab's fallback changes. Cloud remains authoritative.
window.addEventListener("storage", event => {
    if (event.key === cacheKey() || event.key === null) {
        blocked = true;
        say("Browser data changed in another tab. Reload before saving locally; cloud saves remain available.", true);
    }
});

$("auth-form").onsubmit = async event => {
    event.preventDefault();
    if (!client) return;
    $("sign-in").disabled = true;
    try {
        const { error } = await client.auth.signInWithOtp({
            email: $("email").value.trim(),
            options: { emailRedirectTo: location.origin + location.pathname }
        });
        if (error) throw error;
        say("Check your email for a sign-in link. You can keep working locally while you wait.");
    } catch (error) { say(`Sign-in failed: ${error.message}`, true); }
    finally { $("sign-in").disabled = false; }
};

$("sign-out").onclick = async () => {
    if (saving) { say("Please wait for the current save to finish.", true); return; }
    if (hasUnsavedProgress() && !confirm("Sign out and leave unsaved changes?")) return;
    $("sign-out").disabled = true;
    try {
        const { error } = await client.auth.signOut({ scope: "local" });
        if (error) throw error;
        say("Signed out. Guest progress is available on this browser.");
    } catch (error) { say(`Sign-out failed: ${error.message}. You are still signed in.`, true); }
    finally { $("sign-out").disabled = false; }
};

$("sync-now").onclick = async () => {
    if (!user || saving) return;
    if (hasUnsavedProgress()) { say("Save your current edits before refreshing cloud sessions.", true); return; }
    $("sync-now").disabled = true;
    try {
        const epoch = generation;
        for (const session of [...pending()]) {
            if (epoch !== generation || await saveSession(session) !== true) return;
        }
        await loadCloud();
        if (epoch === generation) landing();
    } finally { $("sync-now").disabled = false; }
};

$("import-local").onclick = async () => {
    if (!user || saving) return;
    if (hasUnsavedProgress()) { say("Save your current edits before importing local progress.", true); return; }
    $("import-local").disabled = true;
    const epoch = generation;
    try {
        const local = readCache(KEY);
        // Deterministic per-account IDs make repeated imports safe, even across reloads.
        for (const session of local.sessions) {
            if (epoch !== generation) return;
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${user.id}:${session.id}`));
            const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
            const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
            if (state.sessions.some(s => s.id === id)) continue;
            // Check the server too: importing again never overwrites existing cloud work.
            const { data, error } = await client.from("sessions").select("id").eq("id", id).maybeSingle();
            if (error) throw error;
            if (epoch !== generation) return;
            if (!data && await saveSession({ ...session, id, user_id: user.id }) !== true) return;
        }
        if (epoch === generation) { await loadCloud(); landing(); say("Local progress imported. Your original guest copy remains on this browser."); }
    } catch (error) { say(`Import failed: ${error.message}. Your guest progress is unchanged; retry when connected.`, true); }
    finally { $("import-local").disabled = false; }
};

async function changeAccount(nextUser) {
    if ((user?.id || null) === (nextUser?.id || null)) return;
    if (timerCheckpoint !== null) stopTimer();
    // Preserve the current account's edited notes before an auth change resets the UI.
    if (hasUnsavedProgress()) {
        const session = state.sessions.find(s => s.id === activeId);
        const next = { ...state, sessions: state.sessions.map(s => s.id === activeId
            ? { ...session, note: $("note").value.trim(), pending: !!user, updated: Date.now() } : s) };
        writeCache(next);
        say("Account changed. Notes were kept in the previous browser fallback where possible. Reselect any unsaved photo after signing in again.", true);
    }
    generation++;
    user = nextUser;
    activeId = null;
    draft = null;
    cloudReady = false;
    blocked = false;
    state = readCache(cacheKey());
    if (!user) guestCount = state.sessions.length;
    // Immediately remove the old account's rendered contents, including photo URLs.
    $("preview").removeAttribute("src");
    $("active-goal").textContent = "";
    $("note").value = "";
    $("photo").value = "";
    $("goal").value = "";
    landing();
    if (user) { await loadCloud(); if (!hasUnsavedProgress() && !$("home").hidden) home(); }
}

async function initializeCloud() {
    const config = window.SUPABASE_CONFIG || {};
    if (!config.url || !config.anonKey) {
        say("Cloud sync is not configured yet. You can still save your progress on this browser.");
        return;
    }
    try {
        const sdk = await Promise.race([
            import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm"),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Client download timed out")), 12000))
        ]);
        // Bound network waits so the browser fallback remains usable during outages.
        client = sdk.createClient(config.url, config.anonKey, {
            global: { fetch: (url, options = {}) => fetch(url, {
                ...options,
                signal: options.signal
                    ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
                    : AbortSignal.timeout(15000)
            }) }
        });
        // Defer database work until outside Supabase's auth callback lock.
        client.auth.onAuthStateChange((_event, session) => {
            setTimeout(() => { changeAccount(session?.user || null).catch(error => say(error.message, true)); }, 0);
        });
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        await changeAccount(data.session?.user || null);
        accountUI();
    } catch (error) {
        say(`Cloud connection failed: ${error.message}. Continue locally or reload to retry.`, true);
        accountUI();
    }
}

state = readCache(KEY);
guestCount = state.sessions.length;
landing();
initializeCloud();
