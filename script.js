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

function say(message = "", error = false) {
    $("status").textContent = error ? "" : message;
    $("error").textContent = error ? message : "";
}

function show(id) {
    for (const view of ["setup", "home", "goal-screen", "session"]) {
        $(view).hidden = view !== id;
    }

    $(id).querySelector("h1").focus();
}

function commit(next) {
    if (blocked) {
        say(
            "Saving is unavailable. Copy any unsaved notes, then reload " +
            "after checking browser storage access.",
            true
        );
        return false;
    }

    try {
        localStorage.setItem(KEY, JSON.stringify(next));
        state = next;
        return true;
    } catch {
        say(
            "Save failed. Your changes are still on this screen. " +
            "Browser storage may be blocked or full. " +
            "Try removing the photo and saving again.",
            true
        );
        return false;
    }
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

    for (const session of sessions) {
        const card = document.createElement("article");
        card.className = "card";

        const title = document.createElement("h2");
        title.textContent =
        session.idea || `${names[session.hobby]} in progress`;

        const note = document.createElement("p");
        note.className = "preserve";
        note.textContent = session.note || session.goal;

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Continue ${session.hobby}`;

        button.onclick = () => {
            say();
            openSession(session.id);
        };

        card.append(title, note, button);
        $("saved").append(card);
    }

    show("home");
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
        idea: $("idea").value.trim()
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

$("goal-form").onsubmit = event => {
    event.preventDefault();

    const goal = $("goal").value.trim();

    if (!goal) {
        say("Write a small goal before starting.", true);
        return;
    }

    const session = {
        ...draft,
        goal,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        note: "",
        photo: "",
        updated: Date.now()
    };

    if (commit({
        ...state,
        sessions: [...state.sessions, session]
    })) {
        openSession(session.id);
        say("Goal saved. You can return to it anytime.");
    }
};

function openSession(id) {
    activeId = id;

    const session = state.sessions.find(item => item.id === id);

    $("active-goal").textContent = session.goal;

    $("session-meta").textContent =
    `${names[session.hobby]} · ${session.minutes}-minute goal` +
    (session.materials ? ` · ${session.materials}` : "");

    $("note").value = session.note;
    $("photo").value = "";
    $("remove-photo").checked = false;
    $("photo-controls").hidden = session.hobby === "reading";
    $("preview").hidden = !session.photo;

    if (session.photo) {
        $("preview").src = session.photo;
    } else {
        $("preview").removeAttribute("src");
    }

    $("remove-wrap").hidden = !session.photo;
    show("session");
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

$("progress-form").onsubmit = async event => {
    event.preventDefault();

    const button = $("save-progress");
    button.disabled = true;
    $("leave").disabled = true;
    button.textContent = "Saving…";

    try {
        const session = state.sessions.find(item => item.id === activeId);
        let photo = $("remove-photo").checked ? "" : session.photo;
        const file = $("photo").files[0];

        if (file && !$("remove-photo").checked) {
            photo = await readPhoto(file);
        }

        const updated = {
            ...session,
            note: $("note").value.trim(),
            photo,
            updated: Date.now()
        };

        if (commit({
            ...state,
            sessions: state.sessions.map(item =>
            item.id === activeId ? updated : item
            )
        })) {
            home();
            say(
                "Progress saved. Your next small step will be here " +
                "when you return."
            );
        }
    } catch (error) {
        say(error.message, true);
    } finally {
        button.disabled = false;
        $("leave").disabled = false;
        button.textContent = "Save progress & return home";
    }
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

    home();
    say();
};

window.addEventListener("beforeunload", event => {
    if (hasUnsavedProgress()) {
        event.preventDefault();
        event.returnValue = "";
    }
});

// Prevent this tab from overwriting changes made in another tab.
window.addEventListener("storage", event => {
    if (event.key === KEY || event.key === null) {
        blocked = true;

        say(
            "Saved data changed in another tab. Copy any unsaved notes, " +
            "then reload before saving again.",
            true
        );
    }
});

// Restore saved hobbies and sessions without a check-in.
try {
    const raw = localStorage.getItem(KEY);

    if (raw) {
        const data = JSON.parse(raw);

        const validHobbies =
        Array.isArray(data.hobbies) &&
        data.hobbies.every(hobby => Object.hasOwn(names, hobby));

        const validSessions =
        Array.isArray(data.sessions) &&
        data.sessions.every(session =>
        session &&
        Object.hasOwn(names, session.hobby) &&
        typeof session.id === "string" &&
        ["goal", "note", "photo", "materials", "idea"].every(
            key => typeof session[key] === "string"
        ) &&
        Number.isFinite(session.minutes) &&
        Number.isFinite(session.updated) &&
        (
            !session.photo ||
            /^data:image\/(jpeg|png|webp);base64,/.test(session.photo)
        )
        );

        if (!validHobbies || !validSessions) {
            throw new Error("Invalid saved data");
        }

        state = data;
    }
} catch {
    blocked = true;

    say(
        "Saved data could not be loaded. It has not been overwritten. " +
        "Check browser storage access and reload.",
        true
    );
}

if (state.hobbies.length) {
    home();
} else {
    setup();
}
