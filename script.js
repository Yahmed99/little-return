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

function syncChips() {
    document.querySelectorAll(".chip").forEach(c => {
        const selected = c.dataset.min === $("minutes").value;
        c.classList.toggle("on", selected);
        c.setAttribute("aria-pressed", String(selected));
    });
}
document.querySelectorAll(".chip").forEach(c => c.onclick = () => { $("minutes").value = c.dataset.min; syncChips(); });
$("minutes").addEventListener("input", syncChips);
syncChips();
document.addEventListener("click", e => {
    const menu = document.querySelector(".account");
    if (menu.open && !menu.contains(e.target)) menu.open = false;
    document.querySelectorAll(".project-menu[open]").forEach(projectMenu => {
        if (!projectMenu.contains(e.target)) projectMenu.open = false;
    });
});

let state = { hobbies: [], sessions: [] };
let draft;
let activeId;
let detailId = null;
let openRequest = 0;
let blocked = false;
let client = null;
let user = null;
let cloudReady = false;
let generation = 0;
let saving = false;
let saveRevision = 0;
const volatileDrafts = new Map();
let guestCount = 0;
let homeTab = "projects";
let timerInterval = null;
let timerCheckpoint = null;
let timerLockRequest = null;
let releaseTimerLock = null;
let timerWrites = 0;
let resumeTimerOnVisible = false;
let selectedPhotoPreview = "";
let selectedPhotoRef = "";
let savedPhotoUrl = "";
let photoReading = false;
let photoSelectionVersion = 0;
const BUCKET = "progress-photos";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const emptyState = () => ({ hobbies: [], sessions: [] });
const cacheKey = () => user ? `${KEY}:user:${user.id}` : KEY;
const pending = () => state.sessions.filter(item => item.pending);
const draftKey = (id = "goal") => `${cacheKey()}:draft:${id}`;

function readDraft(key) {
    try { return volatileDrafts.get(key) || JSON.parse(localStorage.getItem(key)); }
    catch { return volatileDrafts.get(key) || null; }
}

function writeDraft(key, value) {
    volatileDrafts.set(key, value);
    try {
        localStorage.setItem(key, JSON.stringify(value));
        volatileDrafts.delete(key);
        return true;
    } catch {
        say("Browser storage is full or blocked. Your draft is available for this visit. Keep this page open and try saving again.", true);
        return false;
    }
}

function clearDraft(key) {
    volatileDrafts.delete(key);
    try { localStorage.removeItem(key); } catch { /* Browser storage may be unavailable. */ }
}

let photoDatabase;
function localPhotoStore() {
    photoDatabase ||= new Promise((resolve, reject) => {
        const request = indexedDB.open("little-return-photos", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("photos");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }).catch(error => { photoDatabase = null; throw error; });
    return photoDatabase;
}

async function storeLocalPhoto(blob) {
    const db = await localPhotoStore();
    const reference = `photo:${crypto.randomUUID()}`;
    await new Promise((resolve, reject) => {
        const transaction = db.transaction("photos", "readwrite");
        transaction.objectStore("photos").put(blob, reference);
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
    });
    return reference;
}

async function localPhotoBlob(reference) {
    if (!reference.startsWith("photo:")) return (await fetch(reference)).blob();
    const db = await localPhotoStore();
    return new Promise((resolve, reject) => {
        const request = db.transaction("photos").objectStore("photos").get(reference);
        request.onsuccess = () => request.result ? resolve(request.result) : reject(new Error("The browser photo is missing"));
        request.onerror = () => reject(request.error);
    });
}

async function localPhotoUrl(reference) {
    return reference.startsWith("photo:") ? readPhoto(await localPhotoBlob(reference)) : reference;
}

async function removeUnreferencedPhotos(photos) {
    const references = new Set(photos.filter(photo => photo?.startsWith("photo:")));
    if (!references.size) return;
    const db = await localPhotoStore();
    const saved = Array.from(volatileDrafts.values(), value => JSON.stringify(value));
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key === KEY || key?.startsWith(`${KEY}:`)) saved.push(localStorage.getItem(key) || "");
    }
    await new Promise((resolve, reject) => {
        const transaction = db.transaction("photos", "readwrite");
        const store = transaction.objectStore("photos");
        for (const reference of references) {
            if (!saved.some(value => value.includes(reference))) store.delete(reference);
        }
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
    });
}

function accountUI() {
    $("account-label").textContent = user
        ? (pending().length ? "Unsynced changes" : cloudReady ? "Saved to account" : "Offline")
        : "Sign in";
    $("login-banner").hidden = !!user;
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
                (!item.photo || /^(photo:[0-9a-f-]+$|data:image\/(jpeg|png|webp);base64,)/.test(item.photo)))) {
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
    const revision = saveRevision;
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
        if (epoch !== generation || revision !== saveRevision || saving) return;
        const waiting = state.sessions.filter(project => project.pending || readDraft(draftKey(project.id)));
        const waitingIds = new Set(waiting.map(project => project.id));
        state.sessions = [...rows.filter(row => !waitingIds.has(row.id)).map(fromRow), ...waiting];
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
    const blob = await localPhotoBlob(session.photo);
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[blob.type];
    if (!extension || blob.size > MAX_PHOTO_BYTES) throw new Error("Invalid progress photo");
    const path = `${owner.id}/${session.id}/${crypto.randomUUID()}.${extension}`;
    const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw error;
    return path;
}

async function persistCloud(session, owner) {
    if (session.pending) {
        const { data, error } = await client.from("sessions").select("*")
            .eq("id", session.id).eq("user_id", owner.id).maybeSingle();
        if (error) throw error;
        if (data && session.saveId && data.last_save_id === session.saveId) return fromRow(data);
        if (session.updated_at ? data?.updated_at !== session.updated_at : !!data) throw cloudConflict();
    }
    const path = await uploadPhoto(session, owner);
    const history = [];
    for (const task of session.taskHistory || []) {
        const storagePath = task.photo
            ? (task.photo === session.photo ? path : await uploadPhoto({ ...session, ...task }, owner))
            : task.storage_path || null;
        history.push({ ...task, photo: "", storage_path: storagePath });
    }
    const row = {
        id: session.id, user_id: owner.id, hobby: session.hobby, minutes: session.minutes,
        materials: session.materials, idea: session.idea, project_name: session.projectName || "",
        goal: session.goal, note: session.note,
        storage_path: path, created_at: session.created_at || new Date(session.updated).toISOString(),
        task_history: history, elapsed_seconds: session.elapsedSeconds || 0,
        goal_completed: !!session.goalCompleted, completed_at: session.completedAt || null,
        last_save_id: session.saveId
    };
    const table = client.from("sessions");
    const request = session.updated_at
        ? table.update(row).eq("id", session.id).eq("user_id", owner.id).eq("updated_at", session.updated_at)
        : table.insert(row);
    const { data, error } = await request.select().maybeSingle();
    // If a response is lost, keep the upload: the database may already reference it.
    if (error?.code === "23505" || (!error && !data)) {
        throw cloudConflict();
    }
    if (error) throw error;
    if (session.storage_path && session.storage_path !== path && !history.some(task => task.storage_path === session.storage_path)) {
        await client.storage.from(BUCKET).remove([session.storage_path]).catch(() => {});
    }
    return fromRow(data);
}

function cloudConflict() {
    return Object.assign(new Error("This project was changed or deleted elsewhere"), { conflict: true });
}

async function saveSession(session, retry = false) {
    if (saving) {
        say("Another save is in progress. Try again when it finishes.", true);
        return false;
    }
    saving = true;
    saveRevision++;
    const owner = user;
    const epoch = generation;
    try {
        if (owner && (!retry || !session.saveId)) session = { ...session, saveId: crypto.randomUUID() };
        let saved = { ...session, pending: !!owner };
        const pendingState = { ...state, sessions: [...state.sessions.filter(s => s.id !== session.id), saved] };
        const staged = writeCache(pendingState);
        if (owner) {
            try {
                saved = await persistCloud(session, owner);
                if (epoch !== generation) return false;
                cloudReady = true;
            } catch (error) {
                if (epoch !== generation) return false;
                cloudReady = false;
                if (!staged) {
                    say(`Cloud save failed: ${error.message}. Browser fallback also failed. Your changes remain on this screen; copy your notes or try again.`, true);
                    return false;
                }
                if (error.conflict) {
                    saved.conflict = true;
                    writeCache(pendingState);
                }
                state = pendingState;
                say(error.conflict
                    ? `${error.message}. Your edits are saved on this browser. Use Keep as a separate project from the project card.`
                    : `Cloud save failed: ${error.message}. Saved only on this browser. Use Save pending changes to retry.`, true);
                return "local";
            }
        }
        if (epoch !== generation) return false;
        const next = { ...state, sessions: [...state.sessions.filter(s => s.id !== session.id), saved] };
        const cached = owner ? writeCache(next) : staged;
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

let sayTimer;
function say(message = "", error = false) {
    $("status").textContent = error ? "" : message;
    $("error").textContent = error ? message : "";
    clearTimeout(sayTimer);
    if (message && !error) sayTimer = setTimeout(() => { $("status").textContent = ""; }, 6000);
}
for (const id of ["status", "error"]) $(id).onclick = () => say();

function show(id) {
    for (const view of ["setup", "home", "goal-screen", "session", "goal-done", "project-detail"]) {
        $(view).hidden = view !== id;
    }

    window.scrollTo(0, 0);
    $(id).querySelector("h1").focus({ preventScroll: true });
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
    const goalDraft = readDraft(draftKey());
    const started = goalDraft && state.sessions.some(project =>
        project.id === goalDraft.project.id && project.goal === goalDraft.goal.trim() && !project.goalCompleted);
    if (started) clearDraft(draftKey());
    $("resume-goal-draft").hidden = !goalDraft || started;
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
        card.dataset.hobby = session.hobby;

        const title = document.createElement("h3");
        title.textContent =
        session.projectName || session.idea || `${names[session.hobby]} in progress`;

        const note = document.createElement("p");
        note.className = "preserve";
        const recovery = readDraft(draftKey(session.id));
        note.textContent = session.goalCompleted ? `Completed goal: ${session.goal}` : `Current goal: ${session.goal}`;
        const lastNote = document.createElement("p");
        lastNote.className = "preserve";
        lastNote.textContent = recovery?.note ?? session.note;
        lastNote.hidden = !lastNote.textContent;

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

        const { header, editor } = projectControls(session, title);
        card.append(header, note, lastNote, time, button, editor);
        if (session.conflict) card.append(conflictButton(session));
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
        card.dataset.hobby = project.hobby;
        const title = document.createElement("h3");
        title.textContent = project.projectName || project.idea || `${names[project.hobby]} project`;
        const meta = document.createElement("p");
        meta.className = "hint";
        meta.textContent = `${names[project.hobby]} · ${formatTime(project.elapsedSeconds)} · Completed ${new Date(project.completedAt).toLocaleDateString()}`;
        const view = document.createElement("button");
        view.type = "button";
        view.className = "project-link";
        view.textContent = title.textContent;
        view.onclick = () => openProjectDetails(project.id);
        title.replaceChildren(view);
        const description = document.createElement("p");
        description.textContent = `${project.taskHistory.length} completed goals · View notes and photos`;
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = "View project";
        open.onclick = () => openProjectDetails(project.id);
        const { header, editor } = projectControls(project, title);
        card.append(header, meta, description, open, editor);
        if (project.conflict) card.append(conflictButton(project));
        gallery.append(card);
    }
    $("completed-empty").hidden = projects.length > 0;
}

function conflictButton(project) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Keep as a separate project";
    button.onclick = async () => {
        if (saving || !user) return;
        const owner = user;
        const epoch = generation;
        button.disabled = true;
        try {
            const id = await stableProjectId(`conflict:${project.id}:${project.saveId}`);
            if (epoch !== generation) return;
            let copy = state.sessions.find(item => item.id === id);
            if (!copy) {
                const { data, error } = await client.from("sessions").select("*")
                    .eq("id", id).eq("user_id", owner.id).maybeSingle();
                if (error) throw error;
                if (data) copy = fromRow(data);
            }
            if (epoch !== generation) return;
            if (!copy) {
                const photos = new Map();
                const keepPhoto = async record => {
                    if (record.photo || !record.storage_path) return record.photo || "";
                    if (!photos.has(record.storage_path)) {
                        const { data, error } = await client.storage.from(BUCKET).download(record.storage_path);
                        if (error) throw error;
                        photos.set(record.storage_path, await storeLocalPhoto(data));
                    }
                    return photos.get(record.storage_path);
                };
                const taskHistory = [];
                for (const task of project.taskHistory) {
                    taskHistory.push({ ...task, photo: await keepPhoto(task), storage_path: null });
                }
                copy = {
                    ...project, id, updated_at: null, storage_path: null,
                    projectName: `${(project.projectName || project.idea || names[project.hobby]).slice(0, 113)} (copy)`,
                    photo: await keepPhoto(project), taskHistory, conflict: false, pending: false,
                    updated: Date.now()
                };
            }
            if (epoch !== generation) return;
            const result = !copy.pending && copy.updated_at
                ? true : await saveSession(copy, !!copy.pending);
            if (epoch !== generation || !result) return;
            if (result === "local") { home(); return; }
            const { data, error } = await client.from("sessions").select("*")
                .eq("id", project.id).eq("user_id", owner.id).maybeSingle();
            if (error) throw error;
            if (epoch !== generation) return;
            if (state.sessions.find(item => item.id === project.id) !== project) {
                throw new Error("The local project changed while the copy was being saved");
            }
            const next = { ...state, sessions: state.sessions.filter(item => item.id !== project.id) };
            if (data) next.sessions.push(fromRow(data));
            if (!writeCache(next)) throw new Error("The copy was saved, but the browser could not update the project list");
            state = next;
            clearDraft(draftKey(project.id));
            accountUI();
            home();
            say("Your edits were saved as a separate project.");
        } catch (error) {
            if (epoch === generation) say(`Could not finish saving the separate project: ${error.message}.`, true);
        } finally { button.disabled = false; }
    };
    return button;
}

function projectControls(project, title) {
    const header = document.createElement("div");
    header.className = "project-card-header";
    const menu = document.createElement("details");
    menu.className = "project-menu";
    const trigger = document.createElement("summary");
    trigger.id = `project-actions-${project.id}`;
    trigger.textContent = "⋯";
    trigger.setAttribute("aria-label", `Actions for ${project.projectName || project.idea || names[project.hobby] + " project"}`);
    const panel = document.createElement("div");
    panel.className = "project-menu-panel";
    const editor = renameControl(project, menu, trigger);
    const rename = editor.firstElementChild;
    const remove = deleteButton(project);
    panel.append(rename);
    if (!project.conflict) panel.append(remove);
    menu.append(trigger, panel);
    menu.onkeydown = event => {
        if (event.key === "Escape") {
            event.preventDefault();
            menu.open = false;
            trigger.focus();
        }
    };
    menu.onfocusout = event => {
        if (!menu.contains(event.relatedTarget)) menu.open = false;
    };
    header.append(title, menu);
    return { header, editor };
}

function renameControl(project, menu = null, trigger = null, onSaved = null) {
    const container = document.createElement("div");
    container.className = "project-rename";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.id = `${onSaved ? "detail-rename" : "rename"}-${project.id}`;
    button.textContent = "Rename project";
    button.setAttribute("aria-label", `Rename ${project.projectName || project.idea || names[project.hobby] + " project"}`);
    const form = document.createElement("form");
    form.hidden = true;
    const label = document.createElement("label");
    label.textContent = "Project name";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 120;
    input.required = true;
    label.append(input);
    const actions = document.createElement("div");
    actions.className = "actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save name";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet";
    cancel.textContent = "Cancel";
    const close = () => {
        form.hidden = true;
        button.hidden = false;
        if (menu) menu.open = false;
        (trigger || button).focus();
    };
    cancel.onclick = close;
    input.oninput = () => input.setCustomValidity("");
    form.onkeydown = event => {
        if (event.key === "Escape" && !save.disabled) { event.preventDefault(); close(); }
    };
    button.onclick = () => {
        const current = state.sessions.find(item => item.id === project.id);
        if (!current) return;
        input.value = current.projectName || current.idea || `${names[current.hobby]} project`;
        input.setCustomValidity("");
        button.hidden = true;
        if (menu) menu.open = false;
        form.hidden = false;
        input.focus();
        input.select();
    };
    form.onsubmit = async event => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name || name.length > 120) {
            input.setCustomValidity("Enter a project name between 1 and 120 characters.");
            input.reportValidity();
            return;
        }
        if (saving) { say("Wait for the current save to finish before renaming.", true); return; }
        const current = state.sessions.find(item => item.id === project.id);
        if (!current) return;
        if (name === current.projectName) { close(); return; }
        save.disabled = cancel.disabled = input.disabled = true;
        try {
            const result = await saveSession({ ...current, projectName: name, updated: Date.now() });
            if (!result) return;
            if (onSaved) await onSaved();
            else home(current.completedAt ? "gallery" : "projects");
            document.getElementById((trigger || button).id)?.focus();
        } finally {
            save.disabled = cancel.disabled = input.disabled = false;
        }
    };
    actions.append(save, cancel);
    form.append(label, actions);
    container.append(button, form);
    return container;
}

function deleteButton(project) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger quiet";
    button.textContent = "Delete project";
    button.setAttribute("aria-label", `Delete ${project.projectName || project.idea || names[project.hobby] + " project"}`);
    button.onclick = () => deleteProject(project.id, button);
    return button;
}

function photoPaths(project) {
    return [...new Set([project.storage_path, ...(project.taskHistory || []).map(task => task.storage_path)].filter(Boolean))];
}

async function deleteProject(id, button) {
    if (saving) { say("Wait for the current save to finish before deleting.", true); return; }
    const project = state.sessions.find(item => item.id === id);
    if (!project || !confirm(`Permanently delete “${project.projectName || project.idea || names[project.hobby] + " project"}”? All its goals, notes and photos will be removed. This cannot be undone.`)) return;
    const epoch = generation;
    const owner = user;
    const next = { ...state, sessions: state.sessions.filter(item => item.id !== id) };
    if (!owner && !writeCache(next)) { say("Could not update browser storage. Project was not deleted. Reload and try again.", true); return; }
    saveRevision++;
    saving = true;
    button.disabled = true;
    let cleanupFailed = false;
    try {
        if (owner) {
            // Read the latest paths before deleting, including photos added on another device.
            const { data, error: readError } = await client.from("sessions").select("*").eq("id", id).eq("user_id", owner.id).maybeSingle();
            if (readError) throw readError;
            if (epoch !== generation) return;
            const paths = [...new Set([...photoPaths(project), ...(data ? photoPaths(fromRow(data)) : [])])];
            if (data) {
                const { data: deleted, error } = await client.from("sessions").delete()
                    .eq("id", id).eq("user_id", owner.id).eq("updated_at", data.updated_at).select("id").maybeSingle();
                if (error) throw error;
                if (!deleted) throw new Error("This project changed while you were deleting it");
            }
            if (paths.length) {
                try {
                    const { error: storageError } = await client.storage.from(BUCKET).remove(paths);
                    cleanupFailed = !!storageError;
                } catch { cleanupFailed = true; }
            }
        }
        if (epoch !== generation) return;
        const cached = !owner || writeCache(next);
        state = next;
        const recovery = readDraft(draftKey(id));
        clearDraft(draftKey(id));
        if (readDraft(draftKey())?.project.id === id) clearDraft(draftKey());
        try {
            await removeUnreferencedPhotos([project.photo, recovery?.photo, ...project.taskHistory.map(task => task.photo)]);
        } catch { cleanupFailed = true; }
        if (epoch !== generation) return;
        if (!owner) guestCount = state.sessions.length;
        detailId = null;
        home(project.completedAt ? "gallery" : "projects");
        accountUI();
        if (cleanupFailed) say("Project deleted. Some photo files could not be removed from storage.", true);
        else if (!cached) say("Project deleted from your account. The browser cache could not be updated.", true);
        else say("Project deleted.");
    } catch (error) {
        if (epoch === generation) {
            say(`Could not confirm deletion: ${error.message}. Refresh projects before retrying.`, true);
        }
    } finally { saving = false; button.disabled = false; }
}

function appendDetailText(container, heading, value) {
    if (!value) return;
    const title = document.createElement("h3");
    title.textContent = heading;
    const text = document.createElement("p");
    text.className = "preserve";
    text.textContent = value;
    container.append(title, text);
}

async function appendDetailPhoto(container, record, epoch, id) {
    if (!record.photo && !record.storage_path) return;
    const image = document.createElement("img");
    image.className = "history-photo";
    image.alt = "Saved project progress";
    image.loading = "lazy";
    try {
        let url = await localPhotoUrl(record.photo || "");
        if (!url && user) {
            const { data, error } = await client.storage.from(BUCKET).createSignedUrl(record.storage_path, 3600);
            if (error) throw error;
            url = data.signedUrl;
        }
        if (epoch !== generation || detailId !== id || !container.isConnected) return;
        if (!url || !(url.startsWith("https://") || /^data:image\/(jpeg|png|webp);base64,/.test(url))) throw new Error("Photo unavailable");
        image.src = url;
        image.onerror = () => { image.replaceWith(document.createTextNode("Photo unavailable. Reopen the project to retry.")); };
        container.append(image);
    } catch {
        if (epoch === generation && detailId === id && container.isConnected) {
            const message = document.createElement("p");
            message.className = "hint";
            message.textContent = "Photo unavailable. Reopen the project when connected to retry.";
            container.append(message);
        }
    }
}

async function openProjectDetails(id, refresh = true) {
    const epoch = generation;
    let project = state.sessions.find(item => item.id === id);
    if (!project) return;
    if (user && refresh && !project.pending) {
        try {
            const { data, error } = await client.from("sessions").select("*").eq("id", id).eq("user_id", user.id).single();
            if (error) throw error;
            if (epoch !== generation) return;
            project = fromRow(data);
            state.sessions = state.sessions.map(item => item.id === id ? project : item);
            writeCache(state);
        } catch (error) {
            if (epoch !== generation) return;
            say(`Could not refresh this project: ${error.message}. Showing the browser copy.`, true);
        }
    }
    if (epoch !== generation) return;
    detailId = id;
    $("detail-title").textContent = project.projectName || project.idea || `${names[project.hobby]} project`;
    $("detail-meta").textContent = `${names[project.hobby]} · ${formatTime(project.elapsedSeconds)} total · ${project.taskHistory.length} goals completed`;
    $("detail-rename").replaceChildren(renameControl(project, null, null, () => openProjectDetails(id, false)));
    const overview = $("detail-overview");
    overview.replaceChildren();
    appendDetailText(overview, "Original idea", project.idea);
    appendDetailText(overview, "Materials", project.materials);
    appendDetailText(overview, "Latest notes", project.note || "No notes saved.");
    const history = $("detail-history");
    history.replaceChildren();
    $("history-help").textContent = "Notes and photos are saved with each goal when it is marked done. Older goals may only include the goal text.";
    for (const task of project.taskHistory) {
        const item = document.createElement("li");
        item.className = "panel";
        const title = document.createElement("h3");
        title.className = "preserve";
        title.textContent = task.goal;
        const meta = document.createElement("p");
        meta.className = "hint";
        meta.textContent = `Completed ${new Date(task.completedAt).toLocaleDateString()}` +
            (Number.isFinite(task.elapsedSeconds) ? ` · ${formatTime(task.elapsedSeconds)}` : "");
        item.append(title, meta);
        appendDetailText(item, "Notes", task.note);
        history.append(item);
        appendDetailPhoto(item, task, epoch, id);
    }
    if (!project.taskHistory.length) {
        const item = document.createElement("li");
        item.className = "panel";
        appendDetailText(item, "Saved goal", project.goal);
        history.append(item);
    }
    $("detail-delete").onclick = () => deleteProject(id, $("detail-delete"));
    show("project-detail");
    appendDetailPhoto(overview, project, epoch, id);
}

$("detail-back").onclick = () => { detailId = null; home("gallery"); };
document.querySelectorAll("[data-sign-in]").forEach(button => {
    button.onclick = event => {
        event.stopPropagation();
        document.querySelector(".account").open = true;
        $("email").focus();
    };
});

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
    const total = Math.max(1, session.minutes * 60);
    $("ring").style.strokeDashoffset = String(339.292 * Math.min(1, elapsed / total));
    $("timer").closest(".timer-box").classList.toggle("over", remaining < 0);
    const running = timerCheckpoint !== null;
    $("toggle-timer").textContent = running ? "Pause timer" : "Resume timer";
    const label = remaining <= 0
        ? (running ? "Planned time reached. Continue at your own pace." : "Paused · planned time reached.")
        : (running ? "Running" : "Paused");
    if ($("timer-state").textContent !== label) $("timer-state").textContent = label;
}

function tickTimer(persist = false) {
    if (!activeId || timerCheckpoint === null) return;
    const seconds = Math.max(0, Math.floor((performance.now() - timerCheckpoint) / 1000));
    if (!seconds) return;
    timerCheckpoint += seconds * 1000;
    saveRevision++;
    state.sessions = state.sessions.map(item => item.id === activeId
        ? { ...item, elapsedSeconds: (item.elapsedSeconds || 0) + seconds, updated: Date.now(),
            saveId: undefined, pending: !!user || item.pending }
        : item);
    timerWrites += seconds;
    updateTimerLabel();
    if (writeCache(state)) timerWrites = 0;
    else if (!persist) say("Tracked time could not be saved to this browser. Keep this page open and use Save & close to retry.", true);
}

function startTimer() {
    const session = state.sessions.find(item => item.id === activeId);
    if (!session || session.goalCompleted || session.completedAt || $("session").hidden || document.hidden) return;
    if (timerCheckpoint !== null || timerLockRequest) return;
    if (blocked) { say("Reload to pick up browser changes before starting the timer.", true); return; }
    const begin = () => {
        timerCheckpoint = performance.now();
        timerWrites = 0;
        timerInterval = setInterval(() => tickTimer(), 1000);
        updateTimerLabel();
    };
    if (!navigator.locks) { begin(); return; }
    const request = {};
    timerLockRequest = request;
    navigator.locks.request(`${cacheKey()}:timer:${activeId}`, { ifAvailable: true }, lock => {
        if (timerLockRequest !== request || document.hidden || $("session").hidden || blocked) return;
        if (!lock) {
            say("This project's timer is already running in another tab.", true);
            return;
        }
        begin();
        return new Promise(resolve => { releaseTimerLock = resolve; });
    }).catch(() => {
        if (timerLockRequest === request) say("Could not start the timer. Try again.", true);
    }).finally(() => {
        if (timerLockRequest === request) timerLockRequest = null;
    });
}

function stopTimer() {
    timerLockRequest = null;
    releaseTimerLock?.();
    releaseTimerLock = null;
    resumeTimerOnVisible = false;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    tickTimer(true);
    timerCheckpoint = null;
    if (timerWrites && !writeCache(state)) {
        say("Tracked time could not be saved to this browser. Keep this page open and use Save & close to retry.", true);
    }
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

function checkpointGoal() {
    if (draft && !$("goal-screen").hidden) {
        writeDraft(draftKey(), { project: draft, goal: $("goal").value, context: $("goal-context").textContent });
    }
}

$("goal").addEventListener("input", checkpointGoal);
$("resume-goal-draft").onclick = () => {
    const saved = readDraft(draftKey());
    if (!saved) return;
    draft = saved.project;
    $("goal").value = saved.goal;
    $("goal-context").textContent = saved.context;
    $("back").textContent = "Back to projects";
    show("goal-screen");
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
    checkpointGoal();
};

$("goal-form").onsubmit = async event => {
    event.preventDefault();

    const goal = $("goal").value.trim();

    if (!goal) {
        say("Write a small goal before starting.", true);
        return;
    }

    const epoch = generation;
    const key = draftKey();
    const startingNewProject = !draft.nextGoal;
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
    $("goal").disabled = true;
    checkpointGoal();
    try {
        const result = await saveSession(session);
        if (result && epoch === generation) {
            clearDraft(key);
            if (startingNewProject) {
                $("plan-form").reset(); syncChips();
                updateHobbyExamples();
            }
            homeTab = "projects";
            await openSession(session.id, false, true);
        }
    } finally { button.disabled = false; $("goal").disabled = false; }
};

async function openSession(id, refresh = true, autoStart = false) {
    const epoch = generation;
    const request = ++openRequest;
    saveRevision++;
    const owner = user;
    let session = state.sessions.find(item => item.id === id);
    if (!session) return;
    let recovery = readDraft(draftKey(id));
    if (recovery && recovery.note.trim() === session.note &&
        (!recovery.photo || recovery.photo === session.photo) &&
        (!recovery.removePhoto || (!session.photo && !session.storage_path))) {
        clearDraft(draftKey(id));
        recovery = null;
    }
    if (owner && refresh && !session.pending && !recovery) {
        try {
            const { data, error } = await client.from("sessions").select("*").eq("id", id).eq("user_id", owner.id).single();
            if (error) throw error;
            if (epoch !== generation || request !== openRequest) return;
            session = fromRow(data);
            state.sessions = state.sessions.map(s => s.id === id ? session : s);
            writeCache(state);
        } catch (error) {
            if (epoch !== generation || request !== openRequest) return;
            say(`Could not refresh this session: ${error.message}. Showing the browser copy.`, true);
        }
    }
    if (epoch !== generation || request !== openRequest) return;
    activeId = id;
    if (session.goalCompleted) {
        showCompletionChoice(session);
        return;
    }
    $("session-title").textContent = session.projectName || session.idea || `${names[session.hobby]} project`;
    $("session-hobby").textContent = names[session.hobby];
    $("note").placeholder = hobbyCopy[session.hobby].note;
    $("active-goal").textContent = session.goal;
    $("session-meta").textContent = `${names[session.hobby]} · ${session.minutes}-minute goal` +
        (session.materials ? ` · ${session.materials}` : "");
    $("note").value = session.note;
    savedPhotoUrl = "";
    resetNewPhoto();
    $("remove-photo").checked = false;
    $("photo-controls").hidden = false;
    $("preview").hidden = true;
    $("preview").removeAttribute("src");
    $("remove-wrap").hidden = !(session.photo || session.storage_path);
    if (recovery) {
        $("note").value = recovery.note;
        selectedPhotoRef = recovery.photo;
        $("remove-photo").checked = recovery.removePhoto;
        if (recovery.photo) {
            $("photo-selection").textContent = "Recovered photo draft";
            $("clear-photo").hidden = false;
        }
        refreshPhotoPreview();
        say("Recovered your unsaved draft. Save & close to keep these edits.");
    }
    show("session");
    resumeTimerOnVisible = autoStart && document.hidden;
    updateTimerLabel();
    if (autoStart) startTimer();
    const version = photoSelectionVersion;
    if (selectedPhotoRef) {
        try {
            const preview = await localPhotoUrl(selectedPhotoRef);
            if (epoch === generation && request === openRequest && activeId === id && version === photoSelectionVersion && !$("session").hidden) {
                selectedPhotoPreview = preview;
                refreshPhotoPreview();
            }
        } catch (error) {
            if (epoch === generation && request === openRequest && activeId === id && version === photoSelectionVersion) {
                say(`Could not load your draft photo: ${error.message}. Clear it or choose a replacement.`, true);
            }
        }
    }
    try {
        let url = await localPhotoUrl(session.photo || "");
        if (!url && session.storage_path && owner) {
            const { data, error } = await client.storage.from(BUCKET).createSignedUrl(session.storage_path, 3600);
            if (error) throw error;
            url = data.signedUrl;
        }
        if (epoch === generation && request === openRequest && activeId === id && !$("session").hidden && url) {
            savedPhotoUrl = url;
            refreshPhotoPreview();
        }
    } catch (error) {
        if (epoch === generation && request === openRequest && activeId === id) {
            say(`Could not load the saved photo: ${error.message}. Reopen the project to retry.`, true);
        }
    }
}

function refreshPhotoPreview() {
    const url = $("remove-photo").checked ? "" : selectedPhotoPreview || savedPhotoUrl;
    $("preview").hidden = !url;
    if (url) $("preview").src = url;
    else $("preview").removeAttribute("src");
}

function resetNewPhoto() {
    photoSelectionVersion++;
    photoReading = false;
    selectedPhotoPreview = "";
    selectedPhotoRef = "";
    $("photo").value = "";
    $("camera-photo").value = "";
    $("photo-selection").textContent = "No new photo selected.";
    $("clear-photo").hidden = true;
    $("photo-dropzone").classList.remove("drag-over");
}

async function prepareProgressPhoto(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        throw new Error("Choose a JPEG, PNG or WebP photo.");
    }
    if (file.size <= MAX_PHOTO_BYTES) return file;
    if (file.size > 25 * 1024 * 1024) throw new Error("Choose a photo up to 25 MiB.");
    const url = URL.createObjectURL(file);
    try {
        const image = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("This photo could not be opened. Choose another JPEG, PNG or WebP."));
            image.src = url;
        });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Photo resizing is unavailable. Choose a photo up to 5 MiB.");
        for (const edge of [1600, 1200, 900]) {
            const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            context.fillStyle = "#FFFFFF";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .85));
            if (blob && blob.size <= MAX_PHOTO_BYTES) {
                return new File([blob], "progress-photo.jpg", { type: "image/jpeg" });
            }
        }
        throw new Error("Could not resize this photo below 5 MiB. Choose a smaller photo.");
    } finally { URL.revokeObjectURL(url); }
}

async function selectProgressPhoto(file) {
    if (!file) return;
    const version = ++photoSelectionVersion;
    photoReading = true;
    $("photo-selection").textContent = "Preparing photo…";
    $("clear-photo").hidden = false;
    try {
        const prepared = await prepareProgressPhoto(file);
        const preview = await readPhoto(prepared);
        let reference;
        try { reference = await storeLocalPhoto(prepared); }
        catch { reference = preview; }
        if (version !== photoSelectionVersion) return;
        selectedPhotoRef = reference;
        selectedPhotoPreview = preview;
        $("remove-photo").checked = false;
        $("photo-selection").textContent = `${file.name} · ${Math.ceil(prepared.size / 1024)} KB · Ready to save`;
        refreshPhotoPreview();
        checkpointProgress();
    } catch (error) {
        if (version !== photoSelectionVersion) return;
        $("photo-selection").textContent = selectedPhotoRef ? "Previous selection kept. Choose another photo to replace it." : "No new photo selected.";
        $("clear-photo").hidden = !selectedPhotoRef;
        say(error.message, true);
    } finally {
        if (version === photoSelectionVersion) {
            photoReading = false;
            $("photo").value = "";
            $("camera-photo").value = "";
        }
    }
}

$("choose-photo").onclick = () => $("photo").click();
$("take-photo").onclick = () => $("camera-photo").click();
$("photo").onchange = event => selectProgressPhoto(event.target.files[0]);
$("camera-photo").onchange = event => selectProgressPhoto(event.target.files[0]);
$("clear-photo").onclick = () => { resetNewPhoto(); refreshPhotoPreview(); checkpointProgress(); };
$("remove-photo").onchange = () => { refreshPhotoPreview(); checkpointProgress(); };
$("note").addEventListener("input", checkpointProgress);

function checkpointProgress() {
    if ($("session").hidden || !activeId) return;
    const key = draftKey(activeId);
    if (!hasUnsavedProgress()) { clearDraft(key); return; }
    const previous = readDraft(key);
    writeDraft(key, {
        note: $("note").value,
        baseVersion: previous ? previous.baseVersion : state.sessions.find(item => item.id === activeId)?.updated_at ?? null,
        photo: selectedPhotoRef,
        removePhoto: $("remove-photo").checked
    });
}
for (const type of ["dragenter", "dragover"]) {
    $("photo-dropzone").addEventListener(type, event => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        $("photo-dropzone").classList.add("drag-over");
    });
}
$("photo-dropzone").addEventListener("dragleave", event => {
    if (!$("photo-dropzone").contains(event.relatedTarget)) $("photo-dropzone").classList.remove("drag-over");
});
$("photo-dropzone").addEventListener("drop", event => {
    event.preventDefault();
    $("photo-dropzone").classList.remove("drag-over");
    if ($("save-progress").disabled) { say("Wait for the current save before adding a photo.", true); return; }
    const files = event.dataTransfer?.files;
    if (files?.length !== 1) { say("Drop one photo at a time.", true); return; }
    selectProgressPhoto(files[0]);
});

function readPhoto(file) {
    return new Promise((resolve, reject) => {
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

        if (!allowedTypes.includes(file.type) || file.size > MAX_PHOTO_BYTES) {
            reject(new Error(
                "Choose a JPEG, PNG or WebP up to 5 MiB, " +
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
    for (const id of ["note", "save-progress", "complete-task", "leave", "toggle-timer", "choose-photo", "take-photo", "clear-photo", "photo", "camera-photo", "remove-photo"]) {
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
        if (epoch !== generation) return;
        if (result) { clearDraft(draftKey(updated.id)); home(); }
        else if (wasRunning) startTimer();
    } catch (error) {
        say(error.message, true);
    } finally {
        setSessionBusy(false);
        button.textContent = "Save & close";
    }
};

async function captureProgress(session) {
    if (photoReading) throw new Error("Your photo is still being prepared. Wait a moment, then save again.");
    let photo = $("remove-photo").checked ? "" : session.photo;
    if (selectedPhotoRef && !$("remove-photo").checked) photo = selectedPhotoRef;
    const recovery = readDraft(draftKey(session.id));
    return {
        updated_at: recovery ? recovery.baseVersion : session.updated_at,
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
                note: captured.note, photo: captured.photo, storage_path: captured.storage_path || null,
                projectElapsedSeconds: timed.elapsedSeconds, elapsedSeconds: taskSeconds(timed) }],
            goalCompleted: true,
            updated: Date.now()
        };
        const result = await saveSession(updated);
        if (epoch !== generation) return;
        if (!result) { if (wasRunning) startTimer(); return; }
        clearDraft(draftKey(updated.id));
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
        nextGoal: true,
        updated_at: project.updated_at,
        created_at: project.created_at,
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
    checkpointGoal();
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
            if (result === true) say("Project completed and moved to Finished.");
        }
    } finally { button.disabled = false; }
};

function hasUnsavedProgress() {
    if ($("session").hidden) return false;

    const session = state.sessions.find(item => item.id === activeId);
    if (!session) return false;

    return (
        $("note").value.trim() !== session.note ||
        !!selectedPhotoRef || photoReading ||
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

    const epoch = generation;
    const wasRunning = timerCheckpoint !== null;
    const updated = stopTimer();
    setSessionBusy(true);
    saveSession(updated).then(result => {
        if (epoch !== generation) return;
        if (result) { clearDraft(draftKey(updated.id)); home(); }
        else if (wasRunning) startTimer();
    }).finally(() => setSessionBusy(false));
};

window.addEventListener("beforeunload", event => {
    if (photoReading || (hasUnsavedProgress() && volatileDrafts.has(draftKey(activeId))) ||
        (!$("goal-screen").hidden && volatileDrafts.has(draftKey()))) {
        event.preventDefault();
        event.returnValue = "";
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        const running = timerCheckpoint !== null || !!timerLockRequest;
        if (running) stopTimer();
        resumeTimerOnVisible = running;
    } else if (resumeTimerOnVisible) {
        resumeTimerOnVisible = false;
        startTimer();
    }
});

window.addEventListener("pagehide", () => {
    checkpointProgress();
    checkpointGoal();
    if (timerCheckpoint !== null || timerLockRequest) stopTimer();
});

// Avoid overwriting another tab's fallback changes. Cloud remains authoritative.
window.addEventListener("storage", event => {
    if (event.key === cacheKey() || event.key === null) {
        blocked = true;
        if (timerCheckpoint !== null || timerLockRequest) stopTimer();
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
    if (photoReading) { say("Wait for the photo draft to finish preparing before signing out.", true); return; }
    checkpointProgress();
    checkpointGoal();
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
    if (!$("session").hidden || !$("goal-screen").hidden) {
        say("Return to Projects before refreshing cloud sessions.", true);
        return;
    }
    $("sync-now").disabled = true;
    try {
        const epoch = generation;
        for (const session of pending().filter(project => !project.conflict)) {
            if (epoch !== generation) return;
            await saveSession(session, true);
        }
        await loadCloud();
        if (epoch === generation && !$("home").hidden) landing();
    } finally { $("sync-now").disabled = false; }
};

async function stableProjectId(seed) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

$("import-local").onclick = async () => {
    if (!user || saving) return;
    if (!$("session").hidden || !$("goal-screen").hidden) {
        say("Return to Projects before importing guest progress.", true);
        return;
    }
    $("import-local").disabled = true;
    const epoch = generation;
    try {
        const local = readCache(KEY);
        // Deterministic per-account IDs make repeated imports safe, even across reloads.
        for (const session of local.sessions) {
            if (epoch !== generation) return;
            const id = await stableProjectId(`${user.id}:${session.id}`);
            if (epoch !== generation) return;
            if (state.sessions.some(s => s.id === id)) continue;
            // Check the server too: importing again never overwrites existing cloud work.
            const { data, error } = await client.from("sessions").select("id").eq("id", id).maybeSingle();
            if (error) throw error;
            if (epoch !== generation) return;
            if (!data && await saveSession({ ...session, id, user_id: user.id }) !== true) return;
        }
        if (epoch === generation) await loadCloud();
        if (epoch === generation && !$("home").hidden) {
            landing();
            say("Local progress imported. Your original guest copy remains on this browser.");
        }
    } catch (error) { say(`Import failed: ${error.message}. Your guest progress is unchanged; retry when connected.`, true); }
    finally { $("import-local").disabled = false; }
};

async function changeAccount(nextUser) {
    if ((user?.id || null) === (nextUser?.id || null)) return;
    if (timerCheckpoint !== null || timerLockRequest) stopTimer();
    checkpointProgress();
    checkpointGoal();
    generation++;
    homeTab = "projects";
    resumeTimerOnVisible = false;
    user = nextUser;
    activeId = null;
    detailId = null;
    $("detail-history").replaceChildren();
    $("detail-overview").replaceChildren();
    $("detail-title").textContent = "Project details";
    draft = null;
    cloudReady = false;
    blocked = false;
    state = readCache(cacheKey());
    if (!user) guestCount = state.sessions.length;
    // Immediately remove the old account's rendered contents, including photo URLs.
    $("preview").removeAttribute("src");
    $("active-goal").textContent = "";
    $("note").value = "";
    savedPhotoUrl = "";
    resetNewPhoto();
    $("goal").value = "";
    landing();
    const epoch = generation;
    if (user) {
        await loadCloud();
        if (epoch === generation && !$("home").hidden) home();
    }
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
