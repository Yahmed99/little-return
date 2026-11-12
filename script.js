"use strict";

const $ = id => document.getElementById(id);
const KEY = "little-return-v1";

const names = {
    drawing: "Drawing",
    reading: "Reading",
    journaling: "Journaling"
};

// Example copy changes with the hobby; user-entered values are never replaced.
const hobbyCopy = {
    drawing: {
        project: "For example: Garden sketches", ideaLabel: "What would you like to draw?",
        idea: "For example: a sunflower", ideaHelp: "A subject or technique you’d like to practise.",
        materialsLabel: "Drawing supplies", materials: "For example: pencil and sketchbook",
        materialsHelp: "Include the tools you have, such as a tablet or watercolors.",
        help: "Choose a subject and we’ll suggest a manageable drawing goal.",
        note: "For example: Outline finished. Next time, shade the petals."
    },
    reading: {
        project: "For example: Reading The Secret Garden", ideaLabel: "What would you like to read?",
        idea: "For example: chapter 3 of The Secret Garden", ideaHelp: "A book, article, or the chapter you want to start with.",
        materialsLabel: "What are you reading with?", materials: "For example: paperback, e-reader, or library app",
        materialsHelp: "Leave this blank if you already have something to read.",
        help: "Choose something to read and we’ll suggest a short reading session.",
        note: "For example: Stopped at page 42. Start with chapter 4 next time."
    },
    journaling: {
        project: "For example: My weekly reflections", ideaLabel: "What would you like to write about?",
        idea: "For example: something I’m looking forward to", ideaHelp: "A topic or question. Leave it blank for a simple reflection prompt.",
        materialsLabel: "Where will you write?", materials: "For example: notebook and pen, or a notes app",
        materialsHelp: "Use whatever is comfortable: paper or a digital journal.",
        help: "Choose a topic and we’ll suggest a small writing goal.",
        note: "For example: Wrote about this week. Next time, reflect on what helped."
    }
};

function updateHobbyExamples() {
    const copy = hobbyCopy[$("hobby").value] || hobbyCopy.drawing;
    $("project-name").placeholder = copy.project;
    $("idea-label").textContent = copy.ideaLabel;
    $("idea").placeholder = copy.idea;
    $("idea-help").textContent = copy.ideaHelp;
    $("materials-label").textContent = copy.materialsLabel;
    $("materials").placeholder = copy.materials;
    $("materials-help").textContent = copy.materialsHelp;
    $("hobby-help").textContent = copy.help;
}

$("hobby").onchange = updateHobbyExamples;

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
let homeTab = "projects";
let timerInterval = null;
let timerCheckpoint = null;
let timerWrites = 0;
let resumeTimerOnVisible = false;
const BUCKET = "progress-photos";
const emptyState = () => ({ hobbies: [], sessions: [] });
const cacheKey = () => user ? `${KEY}:user:${user.id}` : KEY;
const pending = () => state.sessions.filter(item => item.pending);

function accountUI() {
    $("account-label").textContent = user
        ? (pending().length ? "Unsynced changes" : cloudReady ? "Saved to account" : "Offline")
        : "This browser";
    $("auth-form").hidden = !!user;
    $("sign-out").hidden = !user;
    $("import-local").hidden = !user || !guestCount;
    $("sync-now").hidden = !user;
    $("sync-now").textContent = pending().length ? "Save pending changes" : "Refresh saved projects";
    $("sign-in").disabled = !client;
    $("sync-status").textContent = user
        ? `${user.email} · ${pending().length ? `${pending().length} project(s) saved on this browser, waiting to upload.` : cloudReady ? "Your projects are saved to your account." : "Offline. Showing projects saved on this browser."}`
        : "Your projects are saved on this browser. Sign in to use them on other devices.";
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
                say(`Cloud save failed: ${error.message}. Saved only on this browser. Use Save pending changes to retry.`, true);
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

// Keep tab state in memory: switching panels never resets a partially filled form.
const homeTabs = ["projects", "gallery", "new"];

function selectHomeTab(tab, focus = false) {
    if (!homeTabs.includes(tab)) return;
    homeTab = tab;
    for (const name of homeTabs) {
        const selected = name === tab;
        $("tab-" + name).setAttribute("aria-selected", String(selected));
        $("tab-" + name).tabIndex = selected ? 0 : -1;
        $("panel-" + name).hidden = !selected;
    }
    if (focus) $("tab-" + tab).focus();
}

for (const tab of homeTabs) {
    $("tab-" + tab).onclick = () => selectHomeTab(tab);
    $("tab-" + tab).onkeydown = event => {
        const index = homeTabs.indexOf(tab);
        let next;
        if (event.key === "ArrowRight") next = homeTabs[(index + 1) % homeTabs.length];
        if (event.key === "ArrowLeft") next = homeTabs[(index + homeTabs.length - 1) % homeTabs.length];
        if (event.key === "Home") next = homeTabs[0];
        if (event.key === "End") next = homeTabs[homeTabs.length - 1];
        if (next) { event.preventDefault(); selectHomeTab(next, true); }
    };
}
document.querySelectorAll("[data-open-new]").forEach(button => {
    button.onclick = () => { selectHomeTab("new"); $("project-name").focus(); };
});
document.querySelectorAll("[data-open-projects]").forEach(button => {
    button.onclick = () => selectHomeTab("projects", true);
});

function home(tab = homeTab) {
    const selectedHobby = $("hobby").value;
    $("hobby").replaceChildren(
        ...state.hobbies.map(hobby => new Option(names[hobby], hobby))
    );

    if (state.hobbies.includes(selectedHobby)) $("hobby").value = selectedHobby;
    updateHobbyExamples();
    $("saved").replaceChildren();

    const sessions = [...state.sessions].sort(
        (a, b) => b.updated - a.updated
    );

    for (const session of sessions.filter(item => !item.completedAt)) {
        const card = document.createElement("article");
        card.className = "card";

        const title = document.createElement("h3");
        title.textContent =
        session.projectName || session.idea || `${names[session.hobby]} in progress`;

        const note = document.createElement("p");
        note.className = "preserve";
        note.textContent = session.note || session.goal;

        const time = document.createElement("p");
        time.className = "hint project-time";
        time.textContent = `${names[session.hobby]} · ${formatTime(session.elapsedSeconds)} total · ${session.taskHistory.length} goal${session.taskHistory.length === 1 ? "" : "s"} done`;

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = session.goalCompleted ? "Choose next step" : "Continue project";

        button.onclick = () => {
            say();
            openSession(session.id);
        };

        card.append(title, note, time, button);
        $("saved").append(card);
    }
    $("saved-empty").hidden = sessions.some(item => !item.completedAt);

    const completed = sessions.filter(item => item.completedAt);
    renderCompletedProjects(completed);
    $("projects-count").textContent = sessions.length - completed.length;
    $("gallery-count").textContent = completed.length;
    selectHomeTab(tab);
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

function clockTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const part = value => String(value).padStart(2, "0");
    return (hours ? `${part(hours)}:` : "") + `${part(minutes)}:${part(total % 60)}`;
}

function taskSeconds(session) {
    // Completed goals keep a project-time checkpoint inside the existing JSON history.
    const checkpoint = session.taskHistory.at(-1)?.projectElapsedSeconds || 0;
    return Math.max(0, (session.elapsedSeconds || 0) - checkpoint);
}

function updateTimerLabel() {
    const session = state.sessions.find(item => item.id === activeId);
    if (!session) return;
    const elapsed = taskSeconds(session);
    const remaining = session.minutes * 60 - elapsed;
    $("timer").textContent = (remaining < 0 ? "+" : "") + clockTime(Math.abs(remaining));
    $("timer").setAttribute("aria-label", remaining < 0 ? "Time beyond your planned duration" : "Time remaining");
    $("timer-detail").textContent = `${clockTime(elapsed)} on this goal · ${formatTime(session.elapsedSeconds)} on this project`;
    const running = timerCheckpoint !== null;
    $("toggle-timer").textContent = running ? "Pause timer" : "Resume timer";
    const label = remaining <= 0
        ? (running ? "Planned time reached. Continue at your own pace." : "Paused · planned time reached.")
        : (running ? "Running" : "Paused");
    if ($("timer-state").textContent !== label) $("timer-state").textContent = label;
}

function tickTimer(persist = false) {
    if (!activeId || timerCheckpoint === null) return;
    const now = Date.now();
    const seconds = Math.max(0, Math.floor((now - timerCheckpoint) / 1000));
    if (!seconds) return;
    timerCheckpoint += seconds * 1000;
    state.sessions = state.sessions.map(item => item.id === activeId
        ? { ...item, elapsedSeconds: (item.elapsedSeconds || 0) + seconds, updated: now,
            pending: !!user || item.pending }
        : item);
    timerWrites += seconds;
    updateTimerLabel();
    if (persist || timerWrites >= 15) {
        writeCache(state);
        timerWrites = 0;
    }
}

function startTimer() {
    const session = state.sessions.find(item => item.id === activeId);
    if (!session || session.goalCompleted || session.completedAt || $("session").hidden || document.hidden) return;
    if (timerCheckpoint !== null) return;
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
    writeCache(state);
    updateTimerLabel();
    return state.sessions.find(item => item.id === activeId);
}

$("toggle-timer").onclick = () => {
    resumeTimerOnVisible = false;
    if (timerCheckpoint === null) startTimer();
    else stopTimer();
    accountUI();
};

function recommend(hobby, minutes, materials, idea) {
    const available = materials.toLowerCase();
    if (hobby === "reading") {
        return `Read ${idea || "a few pages of your current book or an article"} for ${minutes} minute${minutes === 1 ? "" : "s"}. Mark where you stop so you can return easily.`;
    }
    if (hobby === "journaling") {
        const medium = /phone|tablet|laptop|digital|app/.test(available) ? "your journal or notes app" : "your journal";
        return `In ${medium}, write about ${idea || "one moment from today"} for up to ${minutes} minute${minutes === 1 ? "" : "s"}. ${minutes <= 5 ? "A few words or a sentence is enough." : "Start with what happened and how you felt. Stop whenever you’re ready."}`;
    }
    const subject = idea || "an everyday object, such as a cup";
    const digital = /tablet|ipad|digital|drawing app/.test(available);
    const hasSurface = /paper|sketchbook|notebook|pad|canvas/.test(available);
    const hasTool = /pencil|pen|marker|crayon|charcoal|brush|watercolor|paint/.test(available);
    if (available.trim() && !digital && !(hasSurface && hasTool)) {
        return `Spend up to ${minutes} minutes planning a drawing of ${subject}. Observe the main shapes. Sketch them if you have a drawing tool and surface available.`;
    }
    const medium = digital ? "In your drawing app, sketch" : "Sketch";
    return `${medium} ${subject} for up to ${minutes} minute${minutes === 1 ? "" : "s"}. ${minutes < 10 ? "Focus on the main shapes." : minutes <= 25 ? "Start with the outline, then add a few details if there’s time." : "Start with the outline, then refine the details or add shading."} An unfinished sketch is fine.`;
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
    `${draft.projectName || names[draft.hobby]} · ${draft.minutes} minutes` +
    (draft.materials ? ` · ${draft.materials}` : "");

    $("back").textContent = "Back to project details";
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
            if (startingNewProject) {
                $("plan-form").reset();
                updateHobbyExamples();
            }
            homeTab = "projects";
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
    $("session-title").textContent = session.projectName || session.idea || `${names[session.hobby]} project`;
    $("session-hobby").textContent = names[session.hobby];
    $("note").placeholder = hobbyCopy[session.hobby].note;
    $("photo-controls").open = false;
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
    resumeTimerOnVisible = document.hidden;
    updateTimerLabel();
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

function setSessionBusy(busy) {
    for (const id of ["save-progress", "complete-task", "leave", "toggle-timer"]) {
        $(id).disabled = busy;
    }
}

$("progress-form").onsubmit = async event => {
    event.preventDefault();

    const epoch = generation;
    const button = $("save-progress");
    setSessionBusy(true);
    button.textContent = "Saving…";

    try {
        const session = state.sessions.find(item => item.id === activeId);
        const captured = await captureProgress(session);
        if (epoch !== generation) return;
        const wasRunning = timerCheckpoint !== null;
        const timed = stopTimer();
        const updated = { ...timed, ...captured, updated: Date.now() };
        const result = await saveSession(updated);
        if (result) home();
        else if (wasRunning) startTimer();
    } catch (error) {
        say(error.message, true);
    } finally {
        setSessionBusy(false);
        button.textContent = "Save & close";
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
    setSessionBusy(true);
    try {
        const epoch = generation;
        const session = state.sessions.find(item => item.id === activeId);
        const captured = await captureProgress(session);
        if (epoch !== generation) return;
        const wasRunning = timerCheckpoint !== null;
        const timed = stopTimer();
        const updated = {
            ...timed,
            ...captured,
            taskHistory: [...timed.taskHistory, { goal: timed.goal, completedAt: new Date().toISOString(),
                projectElapsedSeconds: timed.elapsedSeconds, elapsedSeconds: taskSeconds(timed) }],
            goalCompleted: true,
            updated: Date.now()
        };
        const result = await saveSession(updated);
        if (!result) { if (wasRunning) startTimer(); return; }
        showCompletionChoice(updated);
    } catch (error) {
        say(error.message, true);
    } finally { setSessionBusy(false); }
};

$("done-home").onclick = () => { home("projects"); say(); };

$("continue-project").onclick = () => {
    const project = state.sessions.find(item => item.id === activeId);
    // Older completed goals predate timer checkpoints; seed one when continuing.
    const taskHistory = project.taskHistory.map((task, index, tasks) =>
        index === tasks.length - 1 && task.projectElapsedSeconds === undefined
            ? { ...task, projectElapsedSeconds: project.elapsedSeconds } : task);
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
        taskHistory,
        elapsedSeconds: project.elapsedSeconds
    };
    $("goal").value = recommend(draft.hobby, draft.minutes, draft.materials, draft.idea);
    $("goal-context").textContent = `${draft.projectName || draft.idea || names[draft.hobby]} · Next goal`;
    $("back").textContent = "Back to projects";
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
            home("gallery");
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

    const wasRunning = timerCheckpoint !== null;
    const updated = stopTimer();
    setSessionBusy(true);
    saveSession(updated).then(result => {
        if (result) { home(); say(); }
        else if (wasRunning) startTimer();
    }).finally(() => setSessionBusy(false));
};

window.addEventListener("beforeunload", event => {
    if (hasUnsavedProgress()) {
        event.preventDefault();
        event.returnValue = "";
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        resumeTimerOnVisible = timerCheckpoint !== null;
        if (resumeTimerOnVisible) stopTimer();
    } else if (resumeTimerOnVisible) {
        resumeTimerOnVisible = false;
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
    homeTab = "projects";
    resumeTimerOnVisible = false;
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
        say("Account sign-in is not available yet. You can still save projects on this browser.");
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
