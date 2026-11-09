/* =========================================================
   KNG SCHEDULE
   ========================================================= */

const app = document.getElementById("app");

let currentDate = new Date();
let directorWorkspace = (() => { try { return localStorage.getItem("kng.directorWorkspace") || "director"; } catch (_) { return "director"; } })();
let currentView = "month";
let events = [];
let allEvents = [];
let eventTypes = [];
let staff = [];
let currentUser = null;
let currentAccess = null;
let selectedEvent = null;

// Integrated KNG operations layer
const kngStorage = { get(key, fallback="") { try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; } }, set(key, value) { try { localStorage.setItem(key, value); } catch (_) {} } };
let opsView = kngStorage.get("kng.opsView", "schedule");
let ops = { tracker: [], points: [], reductions: [], audit: [], security: [], prizes: [], helpers: [], prizeWins: [], timeouts: [], blocks: [] };
let accessBlock = null;
let currentTimeout = null;
let accessRequests = [];
let opsLoadErrors = {};
let ixView = kngStorage.get("kng.ixView", "");
let hostPlannerDate = kngStorage.get("kng.hostPlannerDate", formatDate(new Date()));
let ixData = { hof: [], goals: [], suggestions: [], eventSubmissions: [] };
let rosterData = [];
let accessDirectory = [];
let actionData = { tracker: [], br: [], logs: [], goals: [], types: [] };
let actionLoadErrors = {};
let crashoutSettings = { max_removals: 3, window_minutes: 60, timeout_minutes: 30 };
if (opsView === "logs" || opsView === "announcements") opsView = "schedule";
if (opsView === "hungry") { opsView = "host-event"; kngStorage.set("kng.opsView","host-event"); }
if (ixView === "announcements" || ixView === "logs") ixView = "command-dashboard";
if (ixView === "daily-goals") ixView = "personal-dashboard";
if (["dashboard", "points", "reductions"].includes(opsView)) { opsView = "schedule"; ixView = "personal-dashboard"; }
let ixLoadErrors = {};


/* =========================================================
   INITIALISE
   ========================================================= */

async function init() {
    try {
        if (!supabaseClient) {
            throw new Error("Supabase could not be initialised. Check the Supabase CDN connection and the publishable key in supabase.js.");
        }
        if (app) {
            app.innerHTML = `<div class="schedule-loading"><div class="loading-card"><strong>KNG Schedule</strong><span>Loading the calendar and workspace data...</span></div></div>`;
        }
        const { data } = await supabaseClient.auth.getSession();

        currentUser = data?.session?.user || null;

        await loadAccess();
        await loadEventTypes();
        await loadStaff();
        await loadEvents();
        await loadAccessRequests();
        await loadOpsData();
        await loadInteractionData();
        await loadRosterData();
        await loadActionData();

        render();

        supabaseClient.auth.onAuthStateChange(async (_event, session) => {
            currentUser = session?.user || null;

            await loadAccess();
            await loadAccessRequests();
            await loadOpsData();
            await loadInteractionData();
            await loadRosterData();
            await loadActionData();
            render();
        });

        setInterval(async () => {
            await loadAccess();
            await loadAccessRequests();
            await loadEvents();
            if (opsView !== "schedule") await loadOpsData();
            await loadInteractionData();
            await loadRosterData();
            await loadActionData();
            render();
        }, 60000);

    } catch (error) {
        console.error(error);

        app.innerHTML = `
            <div class="schedule-error">
                <h1>KNG Schedule</h1>
                <p>Something went wrong while loading the schedule.</p>
                <pre>${escapeHtml(error.message || String(error))}</pre>
            </div>
        `;
    }
}


/* =========================================================
   DATABASE
   ========================================================= */

async function loadEventTypes() {
    const { data, error } = await supabaseClient
        .from("event_types")
        .select("*")
        .order("name");

    if (error) {
        console.error("Event types load failed:", error);
        opsLoadErrors.event_types = error.message || String(error);
        eventTypes = [];
        return;
    }

    eventTypes = data || [];
}


async function loadStaff() {
    const { data, error } = await supabaseClient
        .from("staff")
        .select("*")
        .eq("active", true)
        .order("name");

    if (error) {
        console.error("Staff load failed:", error);
        opsLoadErrors.staff = error.message || String(error);
        staff = [];
        return;
    }

    staff = data || [];
}


async function loadEvents() {
    const result = await supabaseClient
        .from("events")
        .select(`
            *,
            event_types (
                id,
                name,
                colour,
                description
            ),
            event_staff (
                id,
                staff_id,
                role,
                staff (
                    id,
                    name,
                    discord_id
                )
            )
        `)
        .order("event_date")
        .order("start_time");

    if (result.error) {
        console.error("Full event load failed:", result.error);
        opsLoadErrors.events = result.error.message || String(result.error);
        const fallback = await supabaseClient
            .from("events")
            .select("*")
            .order("event_date")
            .order("start_time");
        if (fallback.error) {
            console.error("Fallback event load failed:", fallback.error);
            allEvents = [];
            applyEventVisibility();
            return;
        }
        allEvents = fallback.data || [];
        applyEventVisibility();
        return;
    }

    opsLoadErrors.events = null;
    allEvents = result.data || [];
    applyEventVisibility();
}

function canViewStaffEvents() {
    // Any confirmed KNG staff member can see staff-only meetings/events.
    // Players/public visitors must never receive them in the UI.
    return permissionRank() >= 1;
}

function applyEventVisibility() {
    events = (allEvents || []).filter(e => canViewStaffEvents() || (e.visibility || "public") !== "staff");
}


async function loadAccess() {
    currentAccess = null;
    accessBlock = null;
    currentTimeout = null;

    if (!currentUser) return;

    const email = String(currentUser.email || "").toLowerCase();
    const now = new Date().toISOString();

    const [accessResult, blockResult, timeoutResult] = await Promise.all([
        supabaseClient.from("staff_access").select("access_level, active").eq("user_id", currentUser.id).eq("active", true).maybeSingle(),
        supabaseClient.from("ops_access_blocks").select("*").eq("email", email).eq("active", true).maybeSingle(),
        supabaseClient.from("ops_timeouts").select("*").eq("email", email).gt("expires_at", now).order("expires_at", { ascending: false }).limit(1).maybeSingle()
    ]);

    if (accessResult.error) console.error("Access check failed:", accessResult.error);
    if (blockResult.error && !String(blockResult.error.message || "").includes("does not exist")) console.error("Block check failed:", blockResult.error);
    if (timeoutResult.error && !String(timeoutResult.error.message || "").includes("does not exist")) console.error("Timeout check failed:", timeoutResult.error);

    currentAccess = accessResult.data || null;
    accessBlock = blockResult.data || null;
    currentTimeout = timeoutResult.data || null;

    // staff_access is the authoritative source for site permissions.
    // Do not derive permissions from roster hierarchy here. A roster row says
    // where someone works, not whether they have been granted site access.
    // This prevents a rejected access request (or a stale roster role) from
    // silently granting access again on the next render.

    applyEventVisibility();

    if (accessBlock || currentTimeout) {
        opsView = "schedule";
    }
}


async function loadAccessRequests() {
    accessRequests = [];
    if (!currentUser || !canApproveAccess()) return;

    const { data, error } = await supabaseClient
        .from("staff_access_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(250);

    if (error) {
        if (!String(error.message || "").includes("does not exist")) console.error("Access requests failed:", error);
        return;
    }
    accessRequests = data || [];
}

function getDiscordIdentity() {
    const identity = (currentUser?.identities || []).find(i => i.provider === "discord");
    const data = identity?.identity_data || {};
    const discordId = identity?.provider_id || data?.provider_id || data?.id || data?.sub || null;
    const username = data?.global_name || data?.username || currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || "Discord user";
    const displayName = String(currentUser?.user_metadata?.kng_display_name || username).trim() || username;
    return { discordId: discordId ? String(discordId) : null, username: String(username), displayName };
}

function getKngDisplayName() {
    return getDiscordIdentity().displayName;
}

function openProfileModal() {
    if (!currentUser) return openLogin();
    const current = getKngDisplayName();
    showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">KNG Entertainment</span><h2>My Profile</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><p class="modal-message">Choose the name other staff will see when you claim an event. Your Discord ID stays private and is only used internally.</p><form id="kngProfileForm" class="ops-form"><label>Display Name<input name="display_name" maxlength="80" value="${escapeAttribute(current)}" placeholder="Your KNG display name" required></label><button class="primary-button" type="submit">Save Display Name</button></form></div>`);
    document.getElementById("kngProfileForm")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = String(new FormData(e.target).get("display_name") || "").trim();
        if (!name) return alert("Please enter a display name.");
        const { data, error } = await supabaseClient.auth.updateUser({ data: { kng_display_name: name } });
        if (error) return alert(error.message);
        currentUser = data?.user || currentUser;
        closeModal();
        await loadEvents();
        render();
    });
}

async function requestStaffAccess() {
    if (!currentUser) return openLogin();
    const requestedLevel = nextRequestedAccessLevel();
    if (!requestedLevel) return;
    const { data, error } = await supabaseClient.rpc("request_staff_access", { p_requested_access_level: requestedLevel });
    if (error) {
        console.error(error);
        showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">Access</span><h2>Request failed</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><p class="modal-message">${escapeHtml(error.message)}</p><div class="modal-footer"><button class="primary-button" onclick="closeModal()">Close</button></div></div>`);
        return;
    }

    await loadAccessRequests();
    showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">Access</span><h2>Request sent</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><p class="modal-message">Your Discord account has been sent to staff for confirmation.</p><div class="modal-footer"><button class="primary-button" onclick="closeModal();render();">Done</button></div></div>`);
}


async function approveAccessRequest(requestId, accessLevel) {
    if (!canApproveAccess()) return;
    const request = accessRequests.find(r => String(r.id) === String(requestId));
    const { error } = await supabaseClient.rpc("approve_staff_access_request", { p_request_id: requestId, p_access_level: accessLevel });
    if (error) { alert(error.message); return; }
    await loadAccessRequests();
    await loadOpsData();
    await loadStaff();
    await loadRosterData();
    render();
    if (request?.discord_id && canManage()) {
        const staffRow = staff.find(s => String(s.discord_id || '') === String(request.discord_id));
        if (staffRow) {
            const existing = rosterData.find(r => String(r.staff_id) === String(staffRow.id) && r.active !== false);
            if (!existing) openPostApprovalAllocationModal(staffRow);
        }
    }
}

function openPostApprovalAllocationModal(staffRow) {
    if (!canManage() || !staffRow) return;
    showModal(`<div class="modal small-modal roster-allocation-modal"><div class="modal-header"><div><span class="modal-eyebrow">Staff Approved</span><h2>Allocate ${escapeHtml(staffRow.name || 'Staff Member')}</h2><small>Choose where they belong in KNG Entertainment.</small></div><button class="modal-close" onclick="closeModal()">×</button></div><div class="allocation-choice-grid"><button class="allocation-choice" onclick="finishPostApprovalAllocation('${escapeAttribute(staffRow.id)}','interactions')"><strong>INTERACTIONS</strong><small>Allocate to the Interactions roster</small></button><button class="allocation-choice" onclick="finishPostApprovalAllocation('${escapeAttribute(staffRow.id)}','actions')"><strong>ACTIONS</strong><small>Allocate to the Actions roster</small></button></div><div class="modal-footer"><button class="header-button" onclick="closeModal()">Do this later</button></div></div>`);
}

async function finishPostApprovalAllocation(staffId, team) {
    closeModal();
    await allocateEntertainmentTeam(staffId, team);
}

async function rejectAccessRequest(requestId) {
    if (!canApproveAccess()) return;
    const reason = prompt("Reason for rejecting this access request:", "Not confirmed as KNG staff");
    if (reason === null) return;
    const { error } = await supabaseClient.rpc("reject_staff_access_request", { p_request_id: requestId, p_reason: reason });
    if (error) { alert(error.message); return; }
    await loadAccessRequests();
    render();
}

function getPermissionLevel() {
    // Signing in proves identity, not permission. Until staff explicitly
    // confirms the account, an authenticated user remains PUBLIC.
    if (!currentUser || !currentAccess) return "public";
    return currentAccess.access_level || "public";
}

function permissionRank(level = getPermissionLevel()) {
    return ({ public: 0, member: 1, aux: 2, adm: 3, entertainment_resp: 4, manager: 4, culture_manager: 4, director: 5 }[level] ?? 0);
}

function hasPermission(level) {
    return permissionRank() >= permissionRank(level);
}

function canManage() {
    return hasPermission("adm");
}

function canEntertainment() {
    return hasPermission("adm");
}

function getCurrentStaffRecord() {
    if (!currentUser) return null;
    const discordId = getDiscordIdentity().discordId;
    return (staff || []).find(s =>
        (discordId && String(s.discord_id || "") === String(discordId)) ||
        String(s.user_id || "") === String(currentUser.id || "")
    ) || null;
}

function getCurrentEntertainmentRoster() {
    const staffRow = getCurrentStaffRecord();
    if (!staffRow) return null;
    return (rosterData || []).find(r =>
        String(r.staff_id || "") === String(staffRow.id || "") &&
        r.active !== false
    ) || null;
}

function getCurrentEntertainmentTeam() {
    const roster = getCurrentEntertainmentRoster();
    const team = String(roster?.team || "").toLowerCase();
    return team === "actions" || team === "interactions" ? team : null;
}

function canUseTeam(team) {
    if (!currentUser || permissionRank() < 1) return false;
    // Management, Culture Management and Directors are cross-team by design.
    // They can view both Actions and Interactions regardless of their roster team's assignment.
    if (['manager', 'culture_manager', 'entertainment_resp', 'director'].includes(getPermissionLevel()) || permissionRank() >= 3) return true;
    return getCurrentEntertainmentTeam() === team;
}

function isInteractionsStaff() {
    return canUseTeam("interactions");
}

function isActionsStaff() {
    return canUseTeam("actions");
}

function isTeamSpecificView(view) {
    return {
        "host-event": "interactions",
        "current-host": "interactions",
        "hall-of-fame": "interactions",
        "interactions-leaderboard": "interactions",
        "actions-dashboard": "actions",
        "action-schedule": "actions",
        "action-tracker": "actions",
        "action-br-tracker": "actions",
        "action-log": "actions",
        "action-stats": "actions",
        "action-leaderboard": "actions",
        "action-goals": "actions",
        "host-action": "actions"
    }[view] || null;
}

function isAdmin() {
    return hasPermission("manager");
}

function isDirector() {
    return getPermissionLevel() === "director";
}

function canSwitchTeamWorkspace() {
    return ['director','manager','culture_manager','entertainment_resp'].includes(getPermissionLevel());
}
function isCrossTeamManager() {
    return ['manager','culture_manager','entertainment_resp'].includes(getPermissionLevel());
}
function currentWorkspaceView() {
    if (!canSwitchTeamWorkspace()) return null;
    if (isDirector() && !['director','actions','interactions'].includes(directorWorkspace)) return 'director';
    if (!isDirector() && !['actions','interactions'].includes(directorWorkspace)) return 'actions';
    return directorWorkspace;
}

function canApproveAccess() {
    // Access requests are a Director-controlled gate. Direct role grants still
    // follow the ADM -> Management -> Director security chain.
    return isDirector();
}

function canApproveEvents() {
    return permissionRank() >= 2;
}

function canSubmitEvents() {
    return permissionRank() >= 1;
}

function nextRequestedAccessLevel() {
    const next = ({ public: "member", member: "aux", aux: "adm", adm: "manager" })[getPermissionLevel()];
    return next || null;
}

function availableGrantLevels() {
    const rank = permissionRank();
    const levels = [
        ["member", "Member", 1],
        ["aux", "AUX", 2],
        ["adm", "ADM", 3],
        ["entertainment_resp", "Entertainment Resp", 4],
        ["manager", "Management", 4],
        ["culture_manager", "Culture Manager", 4],
        ["director", "Director", 5]
    ];
    // ADM can grant AUX. Management can grant ADM. Directors can grant any level,
    // including Director for another person. Self-grants are blocked separately.
    return levels.filter(([, , targetRank]) => rank > targetRank || (rank === 5 && targetRank === 5));
}


function directorWorkspaceSwitcher() {
    if (!canSwitchTeamWorkspace()) return "";
    const options = isDirector()
        ? [["director", "DIRECTOR", "Management & control"],["actions", "ACTIONS", "Actions workspace"],["interactions", "INTERACTIONS", "Interactions workspace"]]
        : [["actions", "ACTIONS", "Actions workspace"],["interactions", "INTERACTIONS", "Interactions workspace"]];
    const active = currentWorkspaceView();
    return `<div class="director-workspace-switcher" role="group" aria-label="Team workspace">${options.map(([value,label,title]) => `<button type="button" class="workspace-switch-btn ${active===value?'active':''}" title="${title}" onclick="switchDirectorWorkspace('${value}')">${label}</button>`).join("")}</div>`;
}

async function switchDirectorWorkspace(workspace) {
    if (!canSwitchTeamWorkspace()) return;
    if (isDirector()) { if (!["director","actions","interactions"].includes(workspace)) workspace = "director"; }
    else if (!["actions","interactions"].includes(workspace)) return;
    directorWorkspace = workspace;
    try { localStorage.setItem("kng.directorWorkspace", workspace); localStorage.removeItem("kng.ixView"); localStorage.setItem("kng.opsView", "schedule"); } catch (_) {}
    ixView = "";
    opsView = "schedule";
    render();
}

/* =========================================================
   RENDER
   ========================================================= */

function render() {
    try {
        renderApp();
    } catch (error) {
        console.error("KNG render failed:", error);
        if (app) {
            app.innerHTML = `
                <div class="schedule-error">
                    <h1>KNG Schedule</h1>
                    <p>The app loaded, but one of the workspace panels threw a tantrum.</p>
                    <pre>${escapeHtml(error?.stack || error?.message || String(error))}</pre>
                </div>
            `;
        }
    }
}

function renderApp() {
    const ixViews = ["command-dashboard","interactions-leaderboard","hall-of-fame","personal-dashboard","staff-roster","event-suggestions","public-f3","current-host","actions-dashboard"];
    if (accessBlock || currentTimeout) {
        renderAccessRestriction();
        return;
    }
    if (ixViews.includes(ixView)) { renderInteractionView(); return; }
    if (opsView !== "schedule") {
        renderOperations();
        return;
    }

    app.innerHTML = `
        <div class="schedule-app">

            <header class="schedule-header">

                <div class="schedule-brand">
                    <div class="schedule-logo crown-logo"><img src="kngcroiwn.png" alt="KNG crown"></div>

                    <div>
                        <h1>KNG Entertainment</h1>
                        <span>Events &amp; Community Planning</span>
                    </div>
                </div>

                <div class="schedule-header-actions">

    ${directorWorkspaceSwitcher()}

    ${
        canManage()
            ? `
                <span class="mode-badge staff-mode">
                    STAFF MODE
                </span>

                <button class="primary-button"
                    onclick="openCreateEventModal()">
                    + Create Event
                </button>

                ${isAdmin() ? `<button class="header-button" onclick="openCreateMeetingModal()">+ Meeting</button>` : ""}

                <button class="header-button"
                    onclick="logout()">
                    Logout
                </button>
              `
            : `
                <span class="mode-badge player-mode">
                    ${currentUser ? `${String(getPermissionLevel()).toUpperCase()} ACCESS` : "PUBLIC VIEW"}
                </span>

                ${currentUser ? `${nextRequestedAccessLevel() ? `<button class="header-button" onclick="requestStaffAccess()">Request ${String(nextRequestedAccessLevel()).toUpperCase()} Access</button>` : ""}<button class="header-button" onclick="logout()">Logout</button>` : `<button class="header-button" onclick="openLogin()">Discord Login</button>`}
              `
    }

    <button class="header-button public-f3-button" onclick="switchOpsView('public-f3')">🎮 Public F3</button>

    <button class="header-button"
        onclick="goToday()">
        Today
    </button>

</div>

            </header>


            <div class="app-body">
                ${operationsNavHtml()}
                <main class="schedule-main">

                <section class="calendar-toolbar">

                    <div class="calendar-navigation">

                        <button onclick="previousPeriod()"
                            aria-label="Previous">
                            ‹
                        </button>

                        <h2 id="calendarTitle"></h2>

                        <button onclick="nextPeriod()"
                            aria-label="Next">
                            ›
                        </button>

                    </div>


                    <div class="view-switcher">

                        <button
                            class="${currentView === "month" ? "active" : ""}"
                            onclick="setView('month')">
                            Month
                        </button>

                        <button
                            class="${currentView === "week" ? "active" : ""}"
                            onclick="setView('week')">
                            Week
                        </button>

                        <button
                            class="${currentView === "day" ? "active" : ""}"
                            onclick="setView('day')">
                            Day
                        </button>

                        <button
                            class="${currentView === "agenda" ? "active" : ""}"
                            onclick="setView('agenda')">
                            Agenda
                        </button>

                    </div>

                </section>


                <section id="calendarContainer"
                    class="calendar-container">
                </section>

                </main>
            </div>

        </div>

        <div id="modalContainer"></div>
    `;

    renderCalendar();
}


/* =========================================================
   CALENDAR VIEWS
   ========================================================= */

function renderCalendar() {
    const container = document.getElementById("calendarContainer");

    if (!container) return;

    if (currentView === "month") {
        renderMonth(container);
        return;
    }

    if (currentView === "week") {
        renderWeek(container);
        return;
    }

    if (currentView === "day") {
        renderDay(container);
        return;
    }

    if (currentView === "agenda") {
        renderAgenda(container);
    }
}


/* =========================================================
   MONTH
   ========================================================= */

function renderMonth(container) {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    document.getElementById("calendarTitle").textContent =
        currentDate.toLocaleDateString("en-GB", {
            month: "long",
            year: "numeric"
        });

    const firstDay = new Date(year, month, 1);

    let startOffset = firstDay.getDay();

    // Monday-start calendar
    startOffset = startOffset === 0 ? 6 : startOffset - 1;

    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const previousMonthDays =
        new Date(year, month, 0).getDate();

    let html = `
        <div class="month-calendar">

            <div class="weekday-row">
                ${[
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                    "Sunday"
                ].map(day => `<div>${day}</div>`).join("")}
            </div>

            <div class="month-grid">
    `;

    const totalCells = Math.ceil(
        (startOffset + daysInMonth) / 7
    ) * 7;


    for (let i = 0; i < totalCells; i++) {

        let dayNumber;
        let date;
        let outsideMonth = false;

        if (i < startOffset) {

            dayNumber =
                previousMonthDays - startOffset + i + 1;

            date = new Date(
                year,
                month - 1,
                dayNumber
            );

            outsideMonth = true;

        } else if (i >= startOffset + daysInMonth) {

            dayNumber =
                i - (startOffset + daysInMonth) + 1;

            date = new Date(
                year,
                month + 1,
                dayNumber
            );

            outsideMonth = true;

        } else {

            dayNumber = i - startOffset + 1;

            date = new Date(
                year,
                month,
                dayNumber
            );
        }


        const dateString = formatDate(date);

        // Keep Month view clean. High-volume F3/Host-an-Event slots are not
        // rendered as individual cards here. Week/Day/Agenda and Host an Event
        // remain the detailed views. Meetings stay visible, with a compact count
        // so the month still tells you that the day is busy without becoming a
        // wall of 30-minute boxes.
        const dayEvents = events.filter(event =>
            event.event_date === dateString && Boolean(event.is_meeting)
        );

        const todayClass =
            isToday(date) ? " today" : "";

        const outsideClass =
            outsideMonth ? " outside-month" : "";


        html += `
            <div
                class="month-cell${todayClass}${outsideClass}"
                onclick="handleDateClick('${dateString}')"
            >

                <div class="month-cell-header">
                    <span class="month-day-number">${dayNumber}</span>
                </div>

                <div class="month-events">

                    ${dayEvents.map(event =>
                        renderCalendarEvent(event, "timeline")
                    ).join("")}

                    ${(() => {
                        const f3Count = events.filter(event =>
                            event.event_date === dateString &&
                            !event.is_meeting &&
                            event.status !== 'cancelled'
                        ).length;

                        if (!f3Count) return '';

                        return `<button type="button" class="month-f3-summary" onclick="event.stopPropagation(); currentDate = new Date('${dateString}T12:00:00'); currentView = 'day'; renderCalendar();">🎮 <strong>${f3Count}</strong> F3 event${f3Count === 1 ? '' : 's'}</button>`;
                    })()}

                </div>

            </div>
        `;
    }


    html += `
            </div>
        </div>
    `;

    container.innerHTML = html;
}


/* =========================================================
   WEEK
   ========================================================= */

function renderWeek(container) {

    const start = startOfWeek(currentDate);

    const days = [];

    for (let i = 0; i < 7; i++) {
        const date = new Date(start);
        date.setDate(start.getDate() + i);
        days.push(date);
    }


    document.getElementById("calendarTitle").textContent =
        `${formatShortDate(days[0])} - ${formatShortDate(days[6])}`;


    let html = `
        <div class="week-calendar">

            <div class="week-header">

                <div class="time-column-header"></div>

                ${days.map(date => `
                    <div class="
                        week-day-header
                        ${isToday(date) ? "today" : ""}
                    ">
                        <span>
                            ${date.toLocaleDateString("en-GB", {
                                weekday: "short"
                            })}
                        </span>

                        <strong>
                            ${date.getDate()}
                        </strong>
                    </div>
                `).join("")}

            </div>

            <div class="week-body">
    `;


    for (let hour = 0; hour < 24; hour++) {

        html += `
            <div class="week-row">

                <div class="time-label">
                    ${String(hour).padStart(2, "0")}:00
                </div>
        `;


        days.forEach(date => {

            const dateString = formatDate(date);

            const hourEvents = events.filter(event => {
                if (event.event_date !== dateString) return false;

                const startHour =
                    parseInt(event.start_time.split(":")[0]);

                return startHour === hour;
            });


            html += `
                <div
                    class="week-cell"
                    onclick="handleDateClick('${dateString}', ${hour})"
                >

                    ${renderTimelineEvents(hourEvents)}

                </div>
            `;
        });


        html += `</div>`;
    }


    html += `
            </div>
        </div>
    `;


    container.innerHTML = html;
}


/* =========================================================
   DAY
   ========================================================= */

function renderDay(container) {

    document.getElementById("calendarTitle").textContent =
        currentDate.toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
        });


    const dateString = formatDate(currentDate);

    let html = `
        <div class="day-calendar">

            <div class="day-header">
                ${currentDate.toLocaleDateString("en-GB", {
                    weekday: "long"
                })}
                <strong>
                    ${currentDate.getDate()}
                </strong>
            </div>

            <div class="day-body">
    `;


    for (let hour = 0; hour < 24; hour++) {

        const hourEvents = events.filter(event => {

            if (event.event_date !== dateString) {
                return false;
            }

            return parseInt(
                event.start_time.split(":")[0]
            ) === hour;
        });


        html += `
            <div class="day-row">

                <div class="time-label">
                    ${String(hour).padStart(2, "0")}:00
                </div>

                <div
                    class="day-cell"
                    onclick="handleDateClick('${dateString}', ${hour})"
                >

                    ${renderTimelineEvents(hourEvents)}

                </div>

            </div>
        `;
    }


    html += `
            </div>
        </div>
    `;


    container.innerHTML = html;
}


/* =========================================================
   AGENDA
   ========================================================= */

function renderAgenda(container) {

    document.getElementById("calendarTitle").textContent =
        "Upcoming Events";


    const sortedEvents = [...events].sort((a, b) => {

        const first =
            `${a.event_date} ${a.start_time}`;

        const second =
            `${b.event_date} ${b.start_time}`;

        return first.localeCompare(second);
    });


    if (!sortedEvents.length) {

        container.innerHTML = `
            <div class="empty-state">

                <div class="empty-icon">📅</div>

                <h3>No events scheduled</h3>

                <p>
                    There aren't any events in the schedule yet.
                </p>

            </div>
        `;

        return;
    }


    const grouped = {};


    sortedEvents.forEach(event => {

        if (!grouped[event.event_date]) {
            grouped[event.event_date] = [];
        }

        grouped[event.event_date].push(event);
    });


    let html = `<div class="agenda-list">`;


    Object.entries(grouped).forEach(([date, dateEvents]) => {

        const parsedDate =
            new Date(`${date}T00:00:00`);


        html += `
            <section class="agenda-day">

                <div class="agenda-date">

                    <strong>
                        ${parsedDate.toLocaleDateString(
                            "en-GB",
                            { weekday: "long" }
                        )}
                    </strong>

                    <span>
                        ${parsedDate.toLocaleDateString(
                            "en-GB",
                            {
                                day: "numeric",
                                month: "long",
                                year: "numeric"
                            }
                        )}
                    </span>

                </div>
        `;


        dateEvents.forEach(event => {

            html += renderAgendaEvent(event);

        });


        html += `
            </section>
        `;
    });


    html += `</div>`;


    container.innerHTML = html;
}


/* =========================================================
   EVENT DISPLAY
   ========================================================= */

/* Timeline events that overlap in time are laid out side-by-side.
   This keeps F3 slots and meetings readable instead of stacking on top of
   one another inside the same hourly cell. */
function renderTimelineEvents(hourEvents) {
    if (!hourEvents.length) return "";

    const items = hourEvents.map(event => ({
        event,
        start: hostTimeToMinutes(String(event.start_time || "00:00")),
        end: hostTimeToMinutes(String(event.end_time || event.start_time || "01:00"))
    })).sort((a, b) => a.start - b.start || a.end - b.end);

    const columns = [];
    items.forEach(item => {
        let column = 0;
        while (columns[column] !== undefined && columns[column] > item.start) column++;
        item.column = column;
        columns[column] = item.end;
    });

    const maxColumns = Math.max(1, columns.length);

    return items.map(item => {
        const hourStart = Math.floor(item.start / 60) * 60;
        const top = Math.max(2, (item.start - hourStart) * 1);
        // Timeline cards are intentionally a uniform, compact height.
        // Duration still affects where the event sits, but never makes one
        // event visually larger than another. This keeps meetings and F3
        // slots tidy when they share an hour.
        const height = 28;
        const gap = 4;
        const width = (100 - gap * (maxColumns + 1)) / maxColumns;
        const left = gap + item.column * (width + gap);
        const cappedTop = Math.min(40, top);
        return renderCalendarEvent(item.event, "timeline", {
            left, width, top: cappedTop, height
        });
    }).join("");
}

function renderCalendarEvent(event, context = "default", layout = null) {
    const colour = event.event_types?.colour || "#3b82f6";
    const startM = hostTimeToMinutes(String(event.start_time || "00:00"));
    const endM = hostTimeToMinutes(String(event.end_time || event.start_time || "01:00"));
    const duration = Math.max(15, endM - startM);
    const compact = context === "timeline";
    const type = event.event_types?.name || "Event";
    const allocated = event.event_staff?.length || 0;
    const required = event.staff_required || 0;
    const completed = isEventCompleted(event);
    const timelineStyle = layout ? `position:absolute;left:${layout.left}%;width:${layout.width}%;top:${layout.top}px;height:${layout.height}px;` : "";
    return `<div class="calendar-event ${compact ? 'timeline-event' : ''} ${completed ? 'event-completed' : ''}" style="--event-colour:${colour};--event-duration:${duration};${timelineStyle}" onclick="event.stopPropagation(); openEvent('${event.id}')">
        <span class="event-time">${formatTime(event.start_time)}</span>
        <strong>${escapeHtml(event.title)}</strong>
        <span class="event-type">${escapeHtml(type)}</span>
        ${event.winner_name ? `<span class="event-winner">🏆 ${escapeHtml(event.winner_name)}</span>` : ''}
        ${Number.isFinite(Number(event.attendance_count)) && event.attendance_count !== null ? `<span class="event-attendance">👥 ${Number(event.attendance_count)}</span>` : ''}
        ${required > 0 ? `<span class="event-staff">${allocated}/${required} staff</span>` : ""}
        ${completed ? `<span class="event-status">COMPLETED</span>` : ''}
    </div>`;
}

function renderAgendaEvent(event) {

    const colour =
        event.event_types?.colour || "#3b82f6";

    const allocated =
        event.event_staff?.length || 0;

    const required =
        event.staff_required || 0;


    return `
        <article
            class="agenda-event"
            style="--event-colour:${colour}"
            onclick="openEvent('${event.id}')"
        >

            <div class="agenda-event-time">

                <strong>
                    ${formatTime(event.start_time)}
                </strong>

                <span>
                    ${formatTime(event.end_time)}
                </span>

            </div>


            <div class="agenda-event-main">

                <div class="agenda-event-title">
                    ${escapeHtml(event.title)}
                </div>

                <div class="agenda-event-meta">

                    ${
                        event.event_types?.name
                            ? `<span>
                                ${escapeHtml(
                                    event.event_types.name
                                )}
                               </span>`
                            : ""
                    }

                    ${
                        event.location
                            ? `<span>
                                📍 ${escapeHtml(event.location)}
                               </span>`
                            : ""
                    }

                    ${
                        required > 0
                            ? `<span>
                                👥 ${allocated}/${required} staff
                               </span>`
                            : ""
                    }

                </div>

            </div>

        </article>
    `;
}


/* =========================================================
   ACTION COOLDOWNS
   ========================================================= */
function enforceCooldown(key, seconds = 30) {
    const storageKey = `kng.cooldown.${key}`;
    const now = Date.now();
    const last = Number(kngStorage.get(storageKey, 0)) || 0;
    const remaining = Math.ceil((seconds * 1000 - (now - last)) / 1000);
    if (remaining > 0) return remaining;
    kngStorage.set(storageKey, String(now));
    return 0;
}

/* =========================================================
   EVENT MODALS
   ========================================================= */

function openCreateEventModal(date = null, hour = null) {

    if (!canManage()) {
        showLoginMessage();
        return;
    }


    const defaultDate =
        date || formatDate(currentDate);

    const defaultStart =
        hour !== null
            ? `${String(hour).padStart(2, "0")}:00`
            : "19:00";


    const defaultEnd =
        hour !== null
            ? `${String(Math.min(hour + 1, 23))
                .padStart(2, "0")}:00`
            : "20:00";


    selectedEvent = null;


    showModal(`
        <div class="modal">

            <div class="modal-header">

                <div>
                    <span class="modal-eyebrow">
                        KNG Entertainment · New Event
                    </span>

                    <h2>Create Entertainment Event</h2>
                </div>

                <button
                    class="modal-close"
                    onclick="closeModal()">
                    ×
                </button>

            </div>


            <form onsubmit="submitEntertainmentEvent(event)">

                <div class="form-grid">

                    <div class="form-field full">
                        <label>Event title</label>

                        <input
                            id="eventTitle"
                            required
                            maxlength="120"
                            placeholder="e.g. Battle Royale"
                        >
                        <div class="quick-event-presets">
                            <button type="button" class="quick-event" onclick="applyEventPreset('Party')">PARTY</button>
                            <button type="button" class="quick-event" onclick="applyEventPreset('Event')">EVENT</button>
                            <button type="button" class="quick-event" onclick="applyEventPreset('Battle Royale')">BATTLE ROYALE</button>
                            ${isAdmin()?`<button type="button" class="quick-event" onclick="applyEventPreset('Community Meeting')">COMMUNITY MEETING</button>`:""}
                        </div>
                    </div>


                    <div class="form-field">
                        <label>Event type</label>

                        <select id="eventType" required>

                            ${eventTypes.map(type => `
                                <option value="${type.id}">
                                    ${escapeHtml(type.name)}
                                </option>
                            `).join("")}

                        </select>
                    </div>


                    <div class="form-field">
                        <label>Date</label>

                        <input
                            id="eventDate"
                            type="date"
                            value="${defaultDate}"
                            required
                        >
                    </div>


                    <div class="form-field">
                        <label>Start time</label>

                        <input
                            id="eventStart"
                            type="time"
                            value="${defaultStart}"
                            required
                        >
                    </div>


                    <div class="form-field">
                        <label>End time</label>

                        <input
                            id="eventEnd"
                            type="time"
                            value="${defaultEnd}"
                            required
                        >
                    </div>


                    <div class="form-field full">
                        <label>Location</label>

                        <input
                            id="eventLocation"
                            maxlength="150"
                            placeholder="Optional"
                        >
                    </div>


                    <div class="form-field">
                        <label>Staff required</label>

                        <input
                            id="eventStaffRequired"
                            type="number"
                            min="0"
                            value="0"
                        >
                    </div>


                    <div class="form-field">
                        <label>Visibility</label>
                        <select id="eventVisibility">
                            <option value="public">Player visible</option>
                            <option value="staff">Staff only</option>
                        </select>
                    </div>

                    <div class="form-field">
                        <label>Repeat</label>
                        <select id="eventRepeat">
                            <option value="none">Does not repeat</option>
                            <option value="weekly">Every week</option>
                            <option value="biweekly">Every 2 weeks</option>
                            <option value="monthly">Every month</option>
                        </select>
                    </div>

                    <div class="form-field">
                        <label>Repeat until</label>
                        <input id="eventRepeatUntil" type="date" value="${formatDate(new Date(Date.now()+90*86400000))}">
                    </div>

                    <div class="form-field full">
                        <label>Description</label>

                        <textarea
                            id="eventDescription"
                            rows="5"
                            maxlength="2000"
                            placeholder="Event details..."
                        ></textarea>
                    </div>

                </div>


                <div id="eventFormError"
                    class="form-error">
                </div>


                <div class="modal-footer">

                    <button
                        type="button"
                        class="secondary-button"
                        onclick="closeModal()">
                        Cancel
                    </button>

                    <button
                        type="submit"
                        class="primary-button">
                        Create Event
                    </button>

                </div>

            </form>

        </div>
    `);
}


function openCreateMeetingModal() {
    if (!isAdmin()) return;
    showModal(`<div class="modal"><div class="modal-header"><div><span class="modal-eyebrow">KNG Management · Staff Meeting</span><h2>Add Meeting</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><form onsubmit="createMeeting(event)"><div class="form-grid"><div class="form-field full"><label>Meeting title</label><input id="meetingTitle" required maxlength="120" placeholder="e.g. Management Meeting"></div><div class="form-field"><label>Date</label><input id="meetingDate" type="date" value="${formatDate(currentDate)}" required></div><div class="form-field"><label>Start time</label><input id="meetingStart" type="time" value="19:00" required></div><div class="form-field"><label>End time</label><input id="meetingEnd" type="time" value="20:00" required></div><div class="form-field"><label>Repeat</label><select id="meetingRepeat"><option value="none">Does not repeat</option><option value="weekly">Every week</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Every month</option></select></div><div class="form-field"><label>Repeat until</label><input id="meetingRepeatUntil" type="date" value="${formatDate(new Date(Date.now()+90*86400000))}"></div><div class="form-field full"><label>Meeting notes</label><textarea id="meetingDescription" rows="5" maxlength="2000" placeholder="Agenda, attendees, notes..."></textarea></div></div><div id="meetingFormError" class="form-error"></div><div class="modal-footer"><button type="button" class="secondary-button" onclick="closeModal()">Cancel</button><button type="submit" class="primary-button">Add Meeting</button></div></form></div>`);
}

async function createMeeting(e) {
    e.preventDefault(); if (!isAdmin()) return;
    const title=document.getElementById("meetingTitle").value.trim(); const date=document.getElementById("meetingDate").value; const start=document.getElementById("meetingStart").value; const end=document.getElementById("meetingEnd").value; const repeat=document.getElementById("meetingRepeat").value; const until=document.getElementById("meetingRepeatUntil").value; const description=document.getElementById("meetingDescription").value.trim();
    const err=document.getElementById("meetingFormError");
    if(end<=start){err.textContent="End time must be later than start time."; return;}
    if(repeat!=="none" && until < date){err.textContent="Repeat until must be on or after the first meeting date."; return;}
    const meetingType = eventTypes.find(t => String(t.name||"").toLowerCase() === "staff meeting") || eventTypes.find(t => String(t.name||"").toLowerCase() === "community meeting");
    if (!meetingType) { err.textContent="Staff Meeting event type is missing."; return; }
    const dates=buildRecurringDates(date, repeat, until); const recurrenceGroupId=crypto.randomUUID();
    const rows=dates.map(d=>({title,event_type_id:meetingType.id,event_date:d,start_time:start,end_time:end,location:null,description:description||null,staff_required:0,visibility:"staff",recurrence_group_id:dates.length>1?recurrenceGroupId:null,recurrence_rule:repeat==="none"?null:repeat,status:"scheduled",is_meeting:true,created_by:currentUser?.id||null,updated_by:currentUser?.id||null}));
    const {error}=await supabaseClient.from("events").insert(rows); if(error){err.textContent=error.message;return;}
    await writeAudit("meeting.created",{title,dates,repeat}); closeModal(); await loadEvents(); render();
}

async function submitEntertainmentEvent(event) {

    event.preventDefault();
    const cooldown = enforceCooldown("event-create", 30);
    if (cooldown) {
        const box = document.getElementById("eventFormError");
        if (box) box.textContent = `Event creation is on a 30-second cooldown. Try again in ${cooldown}s.`;
        return;
    }


    const errorBox =
        document.getElementById("eventFormError");

    errorBox.textContent = "";


    const title =
        document.getElementById("eventTitle").value.trim();

    const eventTypeId =
        document.getElementById("eventType").value;

    const eventDate =
        document.getElementById("eventDate").value;

    const startTime =
        document.getElementById("eventStart").value;

    const endTime =
        document.getElementById("eventEnd").value;

    const location =
        document.getElementById("eventLocation").value.trim();

    const staffRequired =
        parseInt(
            document.getElementById(
                "eventStaffRequired"
            ).value
        ) || 0;

    const description =
        document.getElementById(
            "eventDescription"
        ).value.trim();

    let visibility = document.getElementById("eventVisibility")?.value || "public";
    const repeat = document.getElementById("eventRepeat")?.value || "none";
    const repeatUntil = document.getElementById("eventRepeatUntil")?.value || eventDate;
    const selectedType = eventTypes.find(t => t.id === eventTypeId);
    const isMeeting = ["staff meeting", "community meeting"].includes(String(selectedType?.name || "").toLowerCase());
    if (isMeeting && !isAdmin()) { errorBox.textContent = "Only Managers and Directors can create meetings."; return; }
    if (isMeeting) visibility = "staff";


    if (endTime <= startTime) {

        errorBox.textContent =
            "End time must be later than start time.";

        return;
    }

    if (repeat !== "none" && repeatUntil < eventDate) {
        errorBox.textContent = "Repeat until must be on or after the first event date.";
        return;
    }


    const recurrenceGroupId = crypto.randomUUID();
    const dates = buildRecurringDates(eventDate, repeat, repeatUntil);
    const rows = dates.map(d => ({
        title,
        event_type_id: eventTypeId,
        event_date: d,
        start_time: startTime,
        end_time: endTime,
        location: location || null,
        description: description || null,
        staff_required: staffRequired,
        visibility,
        recurrence_group_id: dates.length > 1 ? recurrenceGroupId : null,
        recurrence_rule: repeat === "none" ? null : repeat,
        status: "scheduled",
        is_meeting: isMeeting,
        created_by: currentUser?.id || null,
        updated_by: currentUser?.id || null
    }));

    const { error } = await supabaseClient.from("events").insert(rows);

    if (error) {
        errorBox.textContent = error.message;
        return;
    }

    await writeAudit("event.created", { title, dates, visibility, repeat });


    closeModal();

    await loadEvents();

    render();
}


/* =========================================================
   EVENT DETAILS
   ========================================================= */

async function openEvent(eventId) {
    const event = events.find(item => item.id === eventId);
    if (!event) return;
    selectedEvent = event;
    const feedbackResult = await supabaseClient.from("event_feedback").select("display_name,rating,feedback,created_at").eq("event_id", event.id).order("created_at", {ascending:false}).limit(5);
    const suggestionResult = await supabaseClient.from("event_suggestions").select("display_name,suggestion,created_at,status").eq("event_id", event.id).order("created_at", {ascending:false}).limit(5);
    const feedbackRows = feedbackResult.error ? [] : (feedbackResult.data || []);
    const suggestionRows = suggestionResult.error ? [] : (suggestionResult.data || []);
    const feedbackAverage = feedbackRows.length ? (feedbackRows.reduce((n,r)=>n+Number(r.rating||0),0)/feedbackRows.length).toFixed(1) : null;
    const colour = event.event_types?.colour || "#3b82f6";
    const allocations = event.event_staff || [];
    const passed = new Date(`${event.event_date}T${event.end_time}`) <= new Date();
    const canComplete = canManage() && !event.is_meeting && passed && !isEventCompleted(event);
    const completedLabel = isEventCompleted(event) ? `<div class="event-completion-summary"><b>Completed</b>${event.attendance_count !== null && event.attendance_count !== undefined ? `<span>Attendance: ${Number(event.attendance_count)}</span>` : ''}${event.winner_name ? `<span>Winner: ${escapeHtml(event.winner_name)}</span>` : ''}</div>` : '';
    showModal(`<div class="modal event-detail-modal">
        <div class="event-detail-accent" style="background:${colour}"></div>
        <div class="modal-header"><div><span class="modal-eyebrow">${escapeHtml(event.event_types?.name || "Event")}</span><h2>${escapeHtml(event.title)}</h2></div><button class="modal-close" onclick="closeModal()">×</button></div>
        <div class="event-detail-content">
            <div class="event-detail-row"><span>📅</span><div><strong>Date</strong><p>${formatDisplayDate(event.event_date)}</p></div></div>
            <div class="event-detail-row"><span>⏰</span><div><strong>Time</strong><p>${formatTime(event.start_time)} - ${formatTime(event.end_time)}</p></div></div>
            ${event.location ? `<div class="event-detail-row"><span>📍</span><div><strong>Location</strong><p>${escapeHtml(event.location)}</p></div></div>` : ''}
            ${event.description ? `<div class="event-detail-description"><strong>Description</strong><p>${escapeHtml(event.description).replace(/\n/g,'<br>')}</p></div>` : ''}
            ${event.winner_name ? `<div class="event-detail-description"><strong>🏆 Winner</strong><p>${escapeHtml(event.winner_name)}</p></div>` : ''}
            ${event.attendance_count !== null && event.attendance_count !== undefined ? `<div class="event-detail-description"><strong>👥 Attendance</strong><p>${Number(event.attendance_count)} people attended</p></div>` : ''}
            ${event.staff_required > 0 ? `<div class="staff-section"><div class="staff-section-header"><div><strong>Staff Allocation</strong><span>${allocations.length}/${event.staff_required}</span></div>${canManage()?`<button class="secondary-button" onclick="openStaffAllocation('${event.id}')">Manage Staff</button>`:''}</div>${allocations.length?`<div class="allocated-staff">${allocations.map(a=>`<div class="staff-chip"><span>${escapeHtml(a.staff?.name||"Unknown")}</span>${a.role?`<small>${escapeHtml(a.role)}</small>`:''}</div>`).join('')}</div>`:`<div class="no-staff">No staff allocated yet.</div>`}</div>`:''}
            ${completedLabel}
            <div class="event-feedback-box"><div class="feedback-actions"><button class="secondary-button" onclick="openEventFeedbackModal('${event.id}','feedback')">Give Feedback</button><button class="secondary-button" onclick="openEventFeedbackModal('${event.id}','suggestion')">Suggest an Improvement</button></div>${feedbackAverage?`<div class="feedback-summary"><b>Public feedback: ${feedbackAverage}/5</b><small>Showing ${feedbackRows.length} recent response${feedbackRows.length===1?'':'s'}</small></div>`:''}${feedbackRows.length?`<div class="public-feedback-list">${feedbackRows.map(r=>`<article><b>${escapeHtml(r.display_name||'Anonymous')} · ${'★'.repeat(Number(r.rating||0))}</b><p>${escapeHtml(r.feedback||'')}</p></article>`).join('')}</div>`:''}${suggestionRows.length?`<div class="public-feedback-list"><b>Recent suggestions</b>${suggestionRows.map(r=>`<article><b>${escapeHtml(r.display_name||'Anonymous')}</b><p>${escapeHtml(r.suggestion||'')}</p></article>`).join('')}</div>`:''}</div>
        </div>
        ${canManage()?`<div class="modal-footer"><button class="danger-button" onclick="deleteEvent('${event.id}')">Delete Event</button><div class="modal-footer-right">${canComplete?`<button class="primary-button" onclick="openCompleteEventModal('${event.id}')">Complete Event</button>`:`${isEventCompleted(event)?`<span class="ops-pill">Completed</span>`:''}`}<button class="secondary-button" onclick="openEditEvent('${event.id}')">Edit Event</button><button class="primary-button" onclick="closeModal()">Done</button></div></div>`:`<div class="modal-footer"><button class="primary-button" onclick="closeModal()">Close</button></div>`}
    </div>`);
}

function openCompleteEventModal(eventId){
    if(!canManage()) return;
    const event=events.find(e=>e.id===eventId);
    if(!event || event.is_meeting || isEventCompleted(event)) return;
    showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">Event completion</span><h2>Complete ${escapeHtml(event.title)}</h2><small>Record attendance and the winner before confirming.</small></div><button class="modal-close" onclick="closeModal()">×</button></div><form class="ops-form" id="completeEventForm"><label>How many people showed up?<input name="attendance_count" type="number" min="0" max="100000" required></label><label>Winner name<input name="winner_name" maxlength="120" placeholder="Winner name" required></label><label>Completion notes<textarea name="completion_notes" rows="4" maxlength="1000" placeholder="Optional notes"></textarea></label><button class="primary-button">Confirm Completed Event</button></form></div>`);
    document.getElementById('completeEventForm')?.addEventListener('submit',e=>completeEvent(e,eventId));
}

async function completeEvent(e,eventId){
    e.preventDefault(); if(!canManage()) return;
    const data=Object.fromEntries(new FormData(e.target).entries());
    const attendance=Math.max(0,Number(data.attendance_count)||0);
    const {error}=await supabaseClient.from('events').update({status:'completed',attendance_count:attendance,winner_name:String(data.winner_name||'').trim()||null,completion_notes:String(data.completion_notes||'').trim()||null,completed_at:new Date().toISOString(),completed_by:currentUser?.id||null,updated_by:currentUser?.id||null}).eq('id',eventId);
    if(error) return alert(error.message);
    await writeAudit('event.completed',{event_id:eventId,attendance_count:attendance,winner_name:String(data.winner_name||'').trim()});
    closeModal(); await loadEvents(); await loadInteractionData(); render();
}

/* =========================================================
   EDIT EVENT
/* =========================================================
   EDIT EVENT
   ========================================================= */

function openEditEvent(eventId) {

    const event =
        events.find(item => item.id === eventId);

    if (!event || !canManage()) return;
    if (event.is_meeting && !isAdmin()) {
        alert("Only Managers and Directors can edit staff meetings.");
        return;
    }


    showModal(`
        <div class="modal">

            <div class="modal-header">

                <div>
                    <span class="modal-eyebrow">
                        Edit Event
                    </span>

                    <h2>
                        ${escapeHtml(event.title)}
                    </h2>
                </div>

                <button
                    class="modal-close"
                    onclick="closeModal()">
                    ×
                </button>

            </div>


            <form onsubmit="updateEvent(event, '${event.id}')">

                <div class="form-grid">

                    <div class="form-field full">
                        <label>Event title</label>

                        <input
                            id="editEventTitle"
                            required
                            value="${escapeAttribute(event.title)}"
                        >
                    </div>


                    <div class="form-field">
                        <label>Event type</label>

                        <select id="editEventType" required>

                            ${eventTypes.map(type => `
                                <option
                                    value="${type.id}"
                                    ${type.id === event.event_type_id
                                        ? "selected"
                                        : ""}
                                >
                                    ${escapeHtml(type.name)}
                                </option>
                            `).join("")}

                        </select>
                    </div>


                    <div class="form-field">
                        <label>Date</label>

                        <input
                            id="editEventDate"
                            type="date"
                            value="${event.event_date}"
                            required
                        >
                        ${event.recurrence_group_id ? `<label class="inline-check"><input id="editRecurringAll" type="checkbox" checked> Shift all repeats by the same date change</label><small>This keeps the recurring pattern together instead of making you edit every occurrence like a hostage negotiator.</small>` : ''}
                    </div>


                    <div class="form-field">
                        <label>Start time</label>

                        <input
                            id="editEventStart"
                            type="time"
                            value="${event.start_time.slice(0,5)}"
                            required
                        >
                    </div>


                    <div class="form-field">
                        <label>End time</label>

                        <input
                            id="editEventEnd"
                            type="time"
                            value="${event.end_time.slice(0,5)}"
                            required
                        >
                    </div>


                    <div class="form-field full">
                        <label>Location</label>

                        <input
                            id="editEventLocation"
                            value="${escapeAttribute(
                                event.location || ""
                            )}"
                        >
                    </div>


                    <div class="form-field">
                        <label>Staff required</label>

                        <input
                            id="editEventStaffRequired"
                            type="number"
                            min="0"
                            value="${event.staff_required || 0}"
                        >
                    </div>


                    <div class="form-field">
                        <label>Visibility</label>
                        <select id="editEventVisibility" ${event.is_meeting ? "disabled" : ""}>
                            <option value="public" ${(event.visibility || "public") === "public" ? "selected" : ""}>Player visible</option>
                            <option value="staff" ${event.visibility === "staff" ? "selected" : ""}>Staff only</option>
                        </select>${event.is_meeting ? '<small>Staff meetings are always staff-only.</small>' : ''}
                    </div>

                    <div class="form-field full">
                        <label>Description</label>

                        <textarea
                            id="editEventDescription"
                            rows="5"
                        >${escapeHtml(
                            event.description || ""
                        )}</textarea>
                    </div>

                </div>


                <div id="editEventFormError"
                    class="form-error">
                </div>


                <div class="modal-footer">

                    <button
                        type="button"
                        class="secondary-button"
                        onclick="openEvent('${event.id}')">
                        Cancel
                    </button>

                    <button
                        type="submit"
                        class="primary-button">
                        Save Changes
                    </button>

                </div>

            </form>

        </div>
    `);
}


async function updateEvent(formEvent, eventId) {

    formEvent.preventDefault();


    const errorBox =
        document.getElementById("editEventFormError");

    errorBox.textContent = "";
    const event = events.find(item => item.id === eventId);
    if (!event) {
        errorBox.textContent = "Event could not be found.";
        return;
    }


    const title =
        document.getElementById("editEventTitle")
            .value.trim();

    const eventTypeId =
        document.getElementById("editEventType").value;

    const eventDate =
        document.getElementById("editEventDate").value;

    const startTime =
        document.getElementById("editEventStart").value;

    const endTime =
        document.getElementById("editEventEnd").value;

    const location =
        document.getElementById("editEventLocation")
            .value.trim();

    const staffRequired =
        parseInt(
            document.getElementById(
                "editEventStaffRequired"
            ).value
        ) || 0;

    const description =
        document.getElementById(
            "editEventDescription"
        ).value.trim();
    let visibility = document.getElementById("editEventVisibility")?.value || "public";
    const editingMeeting = Boolean(event && event.is_meeting);
    if (editingMeeting && !isAdmin()) {
        errorBox.textContent = "Only Managers and Directors can edit staff meetings.";
        return;
    }
    if (editingMeeting) visibility = "staff";


    if (endTime <= startTime) {

        errorBox.textContent =
            "End time must be later than start time.";

        return;
    }


    const basePayload = {
        title,
        event_type_id: eventTypeId,
        start_time: startTime,
        end_time: endTime,
        location: location || null,
        description: description || null,
        staff_required: staffRequired,
        visibility,
        updated_by: currentUser?.id || null
    };

    if (event.recurrence_group_id && document.getElementById("editRecurringAll")?.checked && eventDate !== event.event_date) {
        const { data: siblings, error: siblingError } = await supabaseClient
            .from("events")
            .select("id,event_date")
            .eq("recurrence_group_id", event.recurrence_group_id)
            .order("event_date", { ascending: true });
        if (siblingError) { errorBox.textContent = siblingError.message; return; }
        const oldBase = new Date(`${event.event_date}T12:00:00`);
        const newBase = new Date(`${eventDate}T12:00:00`);
        const delta = Math.round((newBase - oldBase) / 86400000);
        for (const sibling of (siblings || [])) {
            const d = new Date(`${sibling.event_date}T12:00:00`);
            d.setDate(d.getDate() + delta);
            const payload = { ...basePayload, event_date: formatDate(d) };
            const { error: updateError } = await supabaseClient.from("events").update(payload).eq("id", sibling.id);
            if (updateError) { errorBox.textContent = updateError.message; return; }
        }
    } else {
        const { error } = await supabaseClient
            .from("events")
            .update({ ...basePayload, event_date: eventDate })
            .eq("id", eventId);
        if (error) { errorBox.textContent = error.message; return; }
    }

    await writeAudit("event.updated", { event_id: eventId, title, visibility });
    closeModal();

    await loadEvents();

    render();
}


/* =========================================================
   DELETE EVENT
   ========================================================= */

async function markEventComplete(eventId) { openCompleteEventModal(eventId); }

async function deleteEvent(eventId) {

    if (!canManage()) return;


    const event =
        events.find(item => item.id === eventId);

    if (!event) return;
    if (event.is_meeting && !isAdmin()) {
        alert("Only Managers and Directors can delete staff meetings.");
        return;
    }


    const confirmed =
        confirm(
            `Delete "${event.title}"?\n\nThis cannot be undone.`
        );


    if (!confirmed) return;


    const { error } =
        await supabaseClient
            .from("events")
            .delete()
            .eq("id", eventId);


    if (error) {

        alert(error.message);

        return;
    }


    await writeAudit("event.deleted", { event_id: eventId, title: event.title });
    closeModal();

    await loadEvents();

    render();
}


/* =========================================================
   STAFF ALLOCATION
   ========================================================= */

function openStaffAllocation(eventId) {

    const event =
        events.find(item => item.id === eventId);

    if (!event || !canManage()) return;


    const allocatedIds =
        new Set(
            (event.event_staff || [])
                .map(item => item.staff_id)
        );


    showModal(`
        <div class="modal">

            <div class="modal-header">

                <div>
                    <span class="modal-eyebrow">
                        Staff Allocation
                    </span>

                    <h2>
                        ${escapeHtml(event.title)}
                    </h2>
                </div>

                <button
                    class="modal-close"
                    onclick="openEvent('${event.id}')">
                    ×
                </button>

            </div>


            <div class="staff-allocation-summary">

                <strong>
                    ${allocatedIds.size}
                    /
                    ${event.staff_required}
                    staff allocated
                </strong>

                <span>
                    Select the staff members attending this event.
                </span>

            </div>


            <div class="staff-list">

                ${
                    staff.length
                        ? staff.map(member => `
                            <label class="staff-option">

                                <input
                                    type="checkbox"
                                    value="${member.id}"
                                    ${allocatedIds.has(member.id)
                                        ? "checked"
                                        : ""}
                                >

                                <span class="staff-option-name">
                                    ${escapeHtml(member.name)}
                                </span>

                                ${
                                    member.discord_id
                                        ? `<small>
                                            ${escapeHtml(
                                                member.discord_id
                                            )}
                                           </small>`
                                        : ""
                                }

                            </label>
                        `).join("")
                        : `
                            <div class="no-staff">
                                No active staff members exist yet.
                            </div>
                        `
                }

            </div>


            <div id="staffAllocationError"
                class="form-error">
            </div>


            <div class="modal-footer">

                <button
                    class="secondary-button"
                    onclick="openEvent('${event.id}')">
                    Cancel
                </button>

                <button
                    class="primary-button"
                    onclick="saveStaffAllocation('${event.id}')">
                    Save Allocation
                </button>

            </div>

        </div>
    `);
}


async function saveStaffAllocation(eventId) {

    if (!canManage()) return;


    const event =
        events.find(item => item.id === eventId);

    if (!event) return;


    const checked =
        [...document.querySelectorAll(
            '.staff-option input:checked'
        )].map(input => input.value);


    const errorBox =
        document.getElementById(
            "staffAllocationError"
        );


    if (
        event.staff_required > 0 &&
        checked.length > event.staff_required
    ) {

        errorBox.textContent =
            `You can only allocate ${event.staff_required} staff members.`;

        return;
    }


    const existing =
        event.event_staff || [];


    const existingIds =
        existing.map(item => item.staff_id);


    const toRemove =
        existing.filter(item =>
            !checked.includes(item.staff_id)
        );


    const toAdd =
        checked.filter(id =>
            !existingIds.includes(id)
        );


    if (toRemove.length) {

        const ids =
            toRemove.map(item => item.id);


        const { error } =
            await supabaseClient
                .from("event_staff")
                .delete()
                .in("id", ids);


        if (error) {

            errorBox.textContent = error.message;

            return;
        }
    }


    if (toAdd.length) {

        const rows =
            toAdd.map(staffId => ({
                event_id: eventId,
                staff_id: staffId,
                role: "Staff",
                allocated_by: currentUser?.id || null
            }));


        const { error } =
            await supabaseClient
                .from("event_staff")
                .insert(rows);


        if (error) {

            errorBox.textContent = error.message;

            return;
        }
    }


    await loadEvents();

    openEvent(eventId);
}


/* =========================================================
   NAVIGATION
   ========================================================= */

function setView(view) {

    currentView = view;

    render();
}


function goToday() {

    currentDate = new Date();

    render();
}


function previousPeriod() {

    if (currentView === "month") {
        currentDate.setMonth(
            currentDate.getMonth() - 1
        );
    }

    else if (
        currentView === "week"
    ) {
        currentDate.setDate(
            currentDate.getDate() - 7
        );
    }

    else {
        currentDate.setDate(
            currentDate.getDate() - 1
        );
    }


    render();
}


function nextPeriod() {

    if (currentView === "month") {
        currentDate.setMonth(
            currentDate.getMonth() + 1
        );
    }

    else if (
        currentView === "week"
    ) {
        currentDate.setDate(
            currentDate.getDate() + 7
        );
    }

    else {
        currentDate.setDate(
            currentDate.getDate() + 1
        );
    }


    render();
}


function handleDateClick(date, hour = null) {

    // Clicking a date from the month view opens that date in the
    // detailed hour-by-hour Day view. Clicking an hour from the
    // day/week view can create an event when Management is signed in.

    if (hour === null) {

        currentDate = new Date(`${date}T12:00:00`);

        currentView = "day";

        render();

        return;
    }


    if (!canManage()) return;


    currentDate = new Date(`${date}T12:00:00`);

    openCreateEventModal(date, hour);
}


/* =========================================================
   MODALS
   ========================================================= */

function showModal(content) {

    const container =
        document.getElementById("modalContainer");

    if (!container) return;

    container.innerHTML = `
        <div
            class="modal-backdrop"
            onclick="handleModalBackdrop(event)"
        >
            ${content}
        </div>
    `;

    document.body.classList.add("modal-open");
    const modal = container.querySelector(".modal");
    if (modal) { modal.addEventListener("input", () => { modal.dataset.dirty = "1"; }, true); modal.addEventListener("change", () => { modal.dataset.dirty = "1"; }, true); modal.addEventListener("submit", () => { modal.dataset.submitting = "1"; }, true); }
}


function handleModalBackdrop(event) {

    if (
        event.target.classList.contains(
            "modal-backdrop"
        )
    ) {
        const modal = event.currentTarget?.querySelector(".modal");
        if (modal?.dataset.dirty === "1" && modal?.dataset.submitting !== "1" && !confirm("You have unsaved changes. Close this form and lose them?")) return;
        closeModal(true);
    }
}


function closeModal(force = false) {

    const container =
        document.getElementById("modalContainer");

    if (container) {
        const modal = container.querySelector(".modal");
        if (!force && modal?.dataset.dirty === "1" && modal?.dataset.submitting !== "1" && !confirm("You have unsaved changes. Close this form and lose them?")) return;
        container.innerHTML = "";
    }

    document.body.classList.remove("modal-open");

    selectedEvent = null;
}


function showLoginMessage() {

    showModal(`
        <div class="modal small-modal">

            <div class="modal-header">

                <div>
                    <span class="modal-eyebrow">
                        Management Access
                    </span>

                    <h2>Sign in required</h2>
                </div>

                <button
                    class="modal-close"
                    onclick="closeModal()">
                    ×
                </button>

            </div>

            <p class="modal-message">
                Public players can view player-facing events. Staff-only events and Entertainment tools require staff access.
            </p>

            <div class="modal-footer">

                <button
                    class="primary-button"
                    onclick="openLogin()">
                    Discord Login
                </button>

            </div>

        </div>
    `);
}


/* =========================================================
   LOGIN
   ========================================================= */

function openLogin() {
    showModal(`
        <div class="modal small-modal discord-login-modal">
            <div class="modal-header">
                <div>
                    <span class="modal-eyebrow">KNG Entertainment</span>
                    <h2>Discord Login</h2>
                </div>
                <button class="modal-close" onclick="closeModal()">×</button>
            </div>

            <p class="modal-message">Sign in with Discord to identify your account. Login alone gives you no KNG permissions. Access is granted through a security chain: ADM confirms Members, Manager confirms Members and ADMs, and Director confirms Members, ADMs and Managers.</p>

            <button class="discord-login-button" onclick="loginWithDiscord()">
                <span class="discord-icon">◈</span>
                Continue with Discord
            </button>

            <div id="loginError" class="form-error"></div>
        </div>
    `);
}

async function loginWithDiscord() {
    const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: "discord",
        options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) {
        const errorBox = document.getElementById("loginError");
        if (errorBox) errorBox.textContent = error.message;
    }
}


async function logout() {
    const { error } = await supabaseClient.auth.signOut();

    if (error) {
        console.error("Logout failed:", error);
        return;
    }

    currentUser = null;
    currentAccess = null;

    render();
}

/* =========================================================
   DATE HELPERS
   ========================================================= */

function formatDate(date) {

    const year =
        date.getFullYear();

    const month =
        String(
            date.getMonth() + 1
        ).padStart(2, "0");

    const day =
        String(
            date.getDate()
        ).padStart(2, "0");


    return `${year}-${month}-${day}`;
}


function formatDisplayDate(dateString) {

    const date =
        new Date(`${dateString}T00:00:00`);


    return date.toLocaleDateString(
        "en-GB",
        {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
        }
    );
}


function formatShortDate(date) {

    return date.toLocaleDateString(
        "en-GB",
        {
            day: "numeric",
            month: "short"
        }
    );
}


function formatTime(time) {

    if (!time) return "";

    const [hour, minute] =
        time.split(":");


    const date =
        new Date();

    date.setHours(
        parseInt(hour),
        parseInt(minute),
        0,
        0
    );


    return date.toLocaleTimeString(
        "en-GB",
        {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }
    );
}


function startOfWeek(date) {

    const result =
        new Date(date);

    const day =
        result.getDay();

    const difference =
        day === 0
            ? -6
            : 1 - day;


    result.setDate(
        result.getDate() + difference
    );


    result.setHours(0, 0, 0, 0);

    return result;
}


function isToday(date) {

    const today =
        new Date();

    return (
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate()
    );
}


/* =========================================================
   SECURITY / HTML HELPERS
   ========================================================= */

function escapeHtml(value) {

    if (value === null || value === undefined) {
        return "";
    }


    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


function escapeAttribute(value) {

    return escapeHtml(value);
}


/* =========================================================
   GLOBAL FUNCTIONS
   ========================================================= */

window.setView = setView;
window.goToday = goToday;
window.previousPeriod = previousPeriod;
window.nextPeriod = nextPeriod;

window.addEventListener("error", (event) => {
    console.error("KNG uncaught error:", event.error || event.message);
    if (app && !app.innerHTML.trim()) {
        app.innerHTML = `<div class="schedule-error"><h1>KNG Schedule</h1><p>A browser-side error stopped the app before it could render.</p><pre>${escapeHtml(event.error?.stack || event.message || "Unknown error")}</pre></div>`;
    }
});
window.addEventListener("unhandledrejection", (event) => {
    console.error("KNG unhandled rejection:", event.reason);
    if (app && !app.innerHTML.trim()) {
        app.innerHTML = `<div class="schedule-error"><h1>KNG Schedule</h1><p>A background request failed before the app could render.</p><pre>${escapeHtml(event.reason?.stack || event.reason?.message || String(event.reason || "Unknown error"))}</pre></div>`;
    }
});

window.handleDateClick = handleDateClick;

window.openCreateEventModal =
    openCreateEventModal;
window.openCreateMeetingModal = openCreateMeetingModal;
window.createMeeting = createMeeting;
window.markEventComplete = markEventComplete;
window.openCompleteEventModal = openCompleteEventModal;
window.completeEvent = completeEvent;

window.submitEntertainmentEvent = submitEntertainmentEvent;

window.openEvent = openEvent;

window.openEditEvent =
    openEditEvent;

window.updateEvent =
    updateEvent;

window.deleteEvent =
    deleteEvent;

window.openStaffAllocation =
    openStaffAllocation;

window.saveStaffAllocation =
    saveStaffAllocation;

window.closeModal =
    closeModal;

window.handleModalBackdrop =
    handleModalBackdrop;

window.openLogin =
    openLogin;
window.openProfileModal =
    openProfileModal;
window.claimHostSlot =
    claimHostSlot;
window.unclaimHostSlot =
    unclaimHostSlot;




/* =========================================================
   INTEGRATED KNG OPERATIONS
   Rebuilds the useful client-side behaviour discovered in the
   public Interactions frontend, using this Schedule's Supabase
   backend instead of the original site's private endpoints.
   ========================================================= */

function operationsNavHtml() {
    const pendingCount = accessRequests.filter(r => r.status === "pending").length;
    const interactionItems = [
        ["host-event", "🎲", "Host an Event"],
        ["current-host", "🎤", "Current Host"],
        ["interactions-leaderboard", "♛", "Leaderboard"],
        ["hall-of-fame", "▣", "Hall of Fame"]
    ];
    const actionItems = [
        ["actions-dashboard", "⚡", "Actions Dashboard"],
        ["host-action", "🎯", "Host an Action"],
        ["action-schedule", "▦", "Action Schedule"],
        ["action-tracker", "▤", "Actions Tracker"],
        ["action-br-tracker", "◈", "BR Tracker"],
        ["action-log", "✎", "Action Log"],
        ["action-leaderboard", "♛", "Performance & Leaderboard"]
    ];
    const sharedItems = [
        ["schedule", "▦", "Schedule"],
        ["event-suggestions", "✦", "Event Suggestions"],
        ["personal-dashboard", "◎", "Personal Dashboard"],
        ["staff-roster", "♙", "Staff Roster"],
        ["prizes", "◇", "Prizes & Commands"],
        ["command-dashboard", "⌂", "Command Dashboard"]
    ];
    const managementItems = [
        ["actions", "⚙", "Team Management"],
        ["access", "✓", `Access Requests${pendingCount ? ` (${pendingCount})` : ""}`],
        ["director-staff", "⌕", "Director Staff Search"],
        ["security", "◉", "Security"]
    ];
    const team = getCurrentEntertainmentTeam();
    const isDirectorUser = isDirector();
    const isWorkspaceManager = canSwitchTeamWorkspace();
    const directorView = isWorkspaceManager ? currentWorkspaceView() : null;
    const baseShared = [sharedItems[0], sharedItems[1], ...(permissionRank() >= 1 ? [...sharedItems.slice(2,4), sharedItems[4]] : [])];
    let items;
    if (isWorkspaceManager) {
        if (directorView === "actions") {
            items = [...baseShared, ...actionItems];
        } else if (directorView === "interactions") {
            items = [...baseShared, ...interactionItems];
        } else if (isDirectorUser && directorView === "director") {
            items = [...baseShared, ...managementItems];
        } else {
            items = [...baseShared, ...actionItems];
        }
    } else {
        items = [...baseShared, ...(canUseTeam("actions") ? actionItems : []), ...(canUseTeam("interactions") ? interactionItems : [])];
    }
    const ixPages = [
        "event-suggestions","public-f3","command-dashboard","interactions-leaderboard",
        "hall-of-fame","personal-dashboard","staff-roster","current-host","actions-dashboard"
    ];
    const activeTeam = isWorkspaceManager ? (directorView === "director" ? "DIRECTOR" : directorView.toUpperCase()) : (team ? team.toUpperCase() : "STAFF");
    return `<aside class="integrated-sidebar" aria-label="KNG navigation">
        <div class="sidebar-section-label">KNG ENTERTAINMENT</div>
        <div class="sidebar-team-badge ${team ? `team-${team}` : "team-management"}"><span></span>${activeTeam} WORKSPACE</div>
        <nav class="integrated-sidebar-nav">
            ${items.map(([id, icon, label]) => {
                const active = id === "schedule"
                    ? (!ixPages.includes(ixView) && opsView === "schedule")
                    : (opsView === id || ixView === id);
                return `<button class="integrated-nav-btn ${active ? "active" : ""}" onclick="switchOpsView('${id}')">
                    <span class="nav-icon">${icon}</span><span>${label}</span>
                </button>`;
            }).join("")}
        </nav>
        <div class="sidebar-spacer"></div>
        <div class="sidebar-access-card">
            <span class="sidebar-access-label">CURRENT ACCESS</span>
            <strong>${escapeHtml(String(getPermissionLevel()).toUpperCase())}</strong>
            ${currentUser ? `<small class="sidebar-display-name">${escapeHtml(getKngDisplayName())}</small><button class="secondary-button small profile-button" onclick="openProfileModal()">Edit Display Name</button>` : `<small>Public visitor</small>`}
        </div>
    </aside>`;
}

function opsHeader(title="KNG Schedule", subtitle="Events & Staff Planning") {
    return `<header class="schedule-header ops-header">
        <div class="schedule-brand">
            <div class="schedule-logo crown-logo"><img src="kngcroiwn.png" alt="KNG crown"></div>
            <div><h1>${escapeHtml(title)}</h1><span>${escapeHtml(subtitle)}</span></div>
        </div>
        <div class="schedule-header-actions">
            ${directorWorkspaceSwitcher()}
            ${canManage()
                ? `<span class="mode-badge staff-mode">STAFF MODE</span>
                   <button class="primary-button" onclick="openCreateEventModal()">+ Create Event</button>
                   ${isAdmin() ? `<button class="header-button" onclick="openCreateMeetingModal()">+ Meeting</button>` : ""}
                   <button class="header-button public-f3-button" onclick="switchOpsView('public-f3')">🎮 Public F3</button>
                   <button class="header-button" onclick="logout()">Logout</button>
                   <button class="header-button" onclick="goToday()">Today</button>`
                : `<span class="mode-badge player-mode">${currentUser ? `${String(getPermissionLevel()).toUpperCase()} ACCESS` : "PUBLIC VIEW"}</span>
                   ${currentUser ? `${nextRequestedAccessLevel() ? `<button class="header-button" onclick="requestStaffAccess()">Request ${String(nextRequestedAccessLevel()).toUpperCase()} Access</button>` : ""}<button class="header-button" onclick="logout()">Logout</button>` : `<button class="header-button" onclick="openLogin()">Discord Login</button>`}
                   <button class="header-button public-f3-button" onclick="switchOpsView('public-f3')">🎮 Public F3</button>
                   <button class="header-button" onclick="goToday()">Today</button>`}
        </div>
    </header>`;
}

async function switchOpsView(view) {
    const publicViews = ["event-suggestions", "public-f3"];
    const sharedStaffViews = ["schedule","event-suggestions","personal-dashboard","staff-roster","command-dashboard"];
    const ixViews = ["command-dashboard","interactions-leaderboard","hall-of-fame","personal-dashboard","staff-roster","event-suggestions","public-f3","current-host","actions-dashboard"];
    const team = isTeamSpecificView(view);

    if (view !== "schedule" && !currentUser && !publicViews.includes(view)) {
        showLoginMessage();
        return;
    }
    if (team && !canUseTeam(team)) {
        showLoginMessage();
        return;
    }
    if (view === "staff-roster" && permissionRank() < 1) {
        showLoginMessage();
        return;
    }
    if ((view === "access" || view === "director-staff") && !isDirector()) {
        showLoginMessage();
        return;
    }
    if (ixViews.includes(view)) {
        ixView = view;
        opsView = "schedule";
        try { localStorage.setItem("kng.ixView", view); localStorage.setItem("kng.opsView", "schedule"); } catch (_) {}
        await loadInteractionData();
        await loadRosterData();
        render();
        return;
    }
    if (team && !canUseTeam(team)) return;
    opsView = view;
    ixView = "";
    if (view === "schedule") { try { localStorage.removeItem("kng.ixView"); } catch (_) {} }
    try { localStorage.setItem("kng.opsView", view); } catch (_) {}
    if (view !== "schedule") await loadOpsData();
    if (String(view).startsWith("action-") || view === "host-action") await loadActionData();
    render();
}

async function loadOpsTable(name, queryFn) {
    try {
        const result = await queryFn();
        if (result.error) throw result.error;
        opsLoadErrors[name] = null;
        return result.data || [];
    } catch (error) {
        opsLoadErrors[name] = error?.message || String(error);
        return [];
    }
}

async function loadOpsData() {
    if (!currentUser) return;
    const [tracker, points, security, prizes, helpers, prizeWins, timeouts, blocks] = await Promise.all([
        loadOpsTable("tracker", () => supabaseClient.from("ops_tracker").select("*, staff(id,name,discord_id)").order("created_at", { ascending: false }).limit(250)),
        loadOpsTable("points", () => supabaseClient.from("ops_points").select("*, staff(id,name,discord_id)").order("created_at", { ascending: false }).limit(1000)),
        loadOpsTable("security", () => supabaseClient.from("ops_security").select("*").order("created_at", { ascending: false }).limit(250)),
        loadOpsTable("prizes", () => supabaseClient.from("ops_prizes").select("*").eq("active", true).order("amount")),
        loadOpsTable("helpers", () => supabaseClient.from("ops_helpers").select("*, staff(id,name,discord_id), events(id,title,event_date,start_time)").order("created_at", { ascending: false }).limit(250)),
        loadOpsTable("prizeWins", () => supabaseClient.from("ops_prize_wins").select("*, ops_prizes(label,code,command_template)").order("created_at", { ascending: false }).limit(250)),
        loadOpsTable("timeouts", () => supabaseClient.from("ops_timeouts").select("*").order("expires_at", { ascending: false }).limit(250)),
        loadOpsTable("blocks", () => supabaseClient.from("ops_access_blocks").select("*").eq("active", true).order("created_at", { ascending: false }).limit(250))
    ]);
    // Host an Event was retired from KNG Entertainment. Host an Event is a
    // separate scheduling tool and does not use the old Host an Event table.
    const reductions = [];
    ops = { tracker, points, reductions, audit: [], security, prizes, helpers, prizeWins, timeouts, blocks };
    const settingsResult = await loadOpsTable("security_settings", () => supabaseClient.from("ops_security_settings").select("*").eq("id", 1).maybeSingle());
    crashoutSettings = { max_removals: Number(settingsResult?.max_removals || 3), window_minutes: Number(settingsResult?.window_minutes || 60), timeout_minutes: Number(settingsResult?.timeout_minutes || 30) };
}

function opsCard(title, body, extra="") {
    return `<section class="ops-card"><div class="ops-card-head"><h3>${title}</h3>${extra}</div>${body}</section>`;
}

function opsErrorNotice(name) {
    const err = opsLoadErrors[name];
    if (!err) return "";
    return `<div class="ops-notice warning">${escapeHtml(name)} is not connected yet. Run <code>KNG-ENTERTAINMENT-COMPLETE-MIGRATION.sql</code> in Supabase. <small>${escapeHtml(err)}</small></div>`;
}

function ixSchemaNotice(name) {
    const err = opsLoadErrors[name];
    if (!err) return "";
    return `<div class="ops-notice warning">${escapeHtml(name)} is not set up yet. Run <code>KNG-ENTERTAINMENT-COMPLETE-MIGRATION.sql</code> in Supabase. <small>${escapeHtml(err)}</small></div>`;
}

function renderOperations() {
    const ixViews = ["command-dashboard","interactions-leaderboard","hall-of-fame","personal-dashboard","staff-roster","event-suggestions","public-f3","current-host","actions-dashboard"];
    if (ixViews.includes(ixView)) { renderInteractionView(); return; }
    if (opsView === "schedule") { render(); return; }
    const team = isTeamSpecificView(opsView);
    if (team && !canUseTeam(team)) {
        opsView = "schedule";
        try { localStorage.setItem("kng.opsView", "schedule"); } catch (_) {}
        render();
        return;
    }
    if ((opsView === "access" || opsView === "director-staff") && !isDirector()) { showLoginMessage(); return; }
    const titles = {
        dashboard: ["KNG Entertainment Dashboard", "Events, completions and staff operations"],
        "command-dashboard": ["Command Dashboard", "KNG Interactions + Entertainment command centre"],
        "interactions-leaderboard": ["Leaderboard", "Staff activity, events and points"],
        "hall-of-fame": ["Hall of Fame", "Winner frames and event recognition"],
        "personal-dashboard": ["Personal Dashboard", "Your daily goal and the useful bits of KNG operations"],
        "staff-roster": ["Staff Roster", "Current KNG Entertainment staff"],
        actions: ["Actions & Interactions", "Tracker, host event, reductions and helpers"],
        tracker: ["Tracker", "Track staff activity and operational work"],
        points: ["Points", "Staff points, adjustments and leaderboard"],
        "host-event": ["Host an Event", "Randomise, plan and manually edit the entertainment schedule"],
        reductions: ["Reductions", "Track staff reductions and reasons"],
        security: ["Security", "Security events and audit visibility"],
        prizes: ["Prizes & Commands", "Prize wins and ready-to-copy commands"],
        helpers: ["Helpers", "Assign additional staff helpers to events"],
        access: ["Access Requests", "Confirm Discord accounts and grant staff permissions"],
        "director-staff": ["Director Staff Search", "Find any linked Discord account and manage its KNG access"],
        "host-action": ["Host an Action", "Submit an Actions event for approval and add it to the shared KNG calendar"],
        "action-schedule": ["Action Schedule", "Actions-only view of the shared KNG calendar"],
        "action-tracker": ["Actions Tracker", "Record completed actions, organisations, attendance and winners"],
        "action-br-tracker": ["Battle Royale Tracker", "Track BR events, attendance, winners and comp status"],
        "action-log": ["Action Log", "Log positive or negative actions with numbers and proof"],
        "action-stats": ["Action Stats", "Monthly action performance and attendance analytics"],
        "action-leaderboard": ["Action Leaderboard", "Who has attended and contributed the most"],
        "action-goals": ["Action Goals", "Team targets and monthly progress"],
    };
    const [title, subtitle] = titles[opsView] || titles.dashboard;
    app.innerHTML = `<div class="schedule-app operations-app">
        ${opsHeader(title, subtitle)}
        <div class="app-body operations-body">
            ${operationsNavHtml()}
            <main class="operations-main">
                <div class="operations-content">${renderOpsViewHtml()}</div>
            </main>
        </div>
        <div id="modalContainer"></div>
    </div>`;
    bindOpsHandlers();
    document.getElementById('directorStaffSearchForm')?.addEventListener('submit', async e => { e.preventDefault(); await searchDirectorStaffDirectory(new FormData(e.target).get('search') || ''); });
    if (opsView === 'director-staff') searchDirectorStaffDirectory('');
    document.getElementById('actionSubmissionForm')?.addEventListener('submit', submitActionEvent);
    document.getElementById('actionLogForm')?.addEventListener('submit', async e => { e.preventDefault(); if(!canSubmitEvents())return; const d=Object.fromEntries(new FormData(e.target).entries()); const {error}=await supabaseClient.from('kng_action_logs').insert({staff_id:getCurrentStaffRecord()?.id||null,organisation:d.organisation||null,action:d.action,result:d.result,numbers:d.numbers||null,proof_url:d.proof_url||null,created_by:currentUser.id}); if(error)return alert(error.message); e.target.reset(); await loadActionData(); render(); });
}

function directorAccessLabel(level) {
    const labels = { member: 'Member', aux: 'AUX', adm: 'ADM', entertainment_resp: 'Entertainment Resp', culture_manager: 'Culture Manager', manager: 'Management', director: 'Director' };
    return labels[String(level || 'member').toLowerCase()] || String(level || 'member').replaceAll('_',' ');
}

let directorStaffSearchTimer = null;
async function searchDirectorStaffDirectory(query='') {
    if (!isDirector()) return;
    const box = document.getElementById('directorStaffResults');
    if (!box) return;
    box.innerHTML = '<div class="ops-card"><p class="ops-muted">Searching staff database…</p></div>';
    const { data, error } = await supabaseClient.rpc('get_kng_director_staff_search', { p_search: String(query || '').trim() });
    if (error) {
        box.innerHTML = `<div class="ops-card schema-error-panel"><strong>Staff search unavailable</strong><small>${escapeHtml(error.message || String(error))}</small></div>`;
        return;
    }
    const rows = data || [];
    if (!rows.length) {
        box.innerHTML = '<div class="ops-card"><h3>No matching staff</h3><p class="ops-muted">Search by Discord ID or name. The person must have logged into KNG Schedule with Discord before access can be granted.</p></div>';
        return;
    }
    box.innerHTML = rows.map(r => {
        const level = String(r.access_level || 'member').toLowerCase();
        const teams = r.teams ? String(r.teams).split(',').map(x => x.trim().toUpperCase()).join(' · ') : 'NOT ALLOCATED';
        const roles = r.roster_roles ? String(r.roster_roles).split(',').map(x => rosterLevelLabel(x.trim(), '')).join(' · ') : 'NOT ON ROSTER';
        const options = [
            ['member','Member'],['aux','AUX'],['adm','ADM'],['entertainment_resp','Entertainment Resp'],['culture_manager','Culture Manager'],['manager','Management'],['director','Director']
        ].map(([v,l]) => `<option value="${v}" ${level===v?'selected':''}>${l}</option>`).join('');
        return `<article class="ops-card director-staff-result">
            <div class="ops-card-head"><div><h3>${escapeHtml(r.name || 'Discord user')}</h3><small>Discord: ${escapeHtml(r.discord_id || 'Unknown')}</small></div><span class="mode-badge staff-mode">${escapeHtml(directorAccessLabel(level))}</span></div>
            <div class="ops-grid compact-ops-grid director-staff-meta">
                <div><span>Teams</span><strong>${escapeHtml(teams)}</strong></div>
                <div><span>Roster role</span><strong>${escapeHtml(roles)}</strong></div>
                <div><span>Discord linked</span><strong>${r.linked ? 'YES' : 'NO'}</strong></div>
            </div>
            <div class="director-staff-controls">
                <select id="director-access-${escapeAttribute(r.discord_id || '')}" aria-label="Set access for ${escapeAttribute(r.name || 'staff member')}">${options}</select>
                <button class="primary-button" onclick="setDirectorStaffAccess('${escapeAttribute(r.discord_id || '')}')">Set Access</button>
            </div>
        </article>`;
    }).join('');
}

function renderDirectorStaffSearch() {
    if (!isDirector()) return '<div class="ops-card"><h3>Director access required</h3></div>';
    return `<div class="ops-view director-staff-search-view">
        ${opsCard('Director Staff Search', '<p class="ops-muted">This is the full access directory, not the team roster. Search by Discord ID or name, including people who are not allocated to Actions or Interactions. Directors can promote or demote any other linked account here.</p>', '<span class="mode-badge staff-mode">DIRECTOR ONLY</span>')}
        <section class="ops-card">
            <form id="directorStaffSearchForm" class="director-staff-search-form">
                <input id="directorStaffSearchInput" name="search" maxlength="100" placeholder="Search Discord ID or name…" autocomplete="off">
                <button class="primary-button" type="submit">Search</button>
                <button class="header-button" type="button" onclick="document.getElementById('directorStaffSearchInput').value='';searchDirectorStaffDirectory('')">Show All</button>
            </form>
            <small class="ops-muted">Access changes here do not require the person to be on an Actions or Interactions roster. They only need to have linked their Discord account to KNG Schedule.</small>
        </section>
        <div id="directorStaffResults"><div class="ops-card"><p class="ops-muted">Loading staff directory…</p></div></div>
    </div>`;
}

async function setDirectorStaffAccess(discordId) {
    if (!isDirector()) return;
    const select = document.getElementById(`director-access-${discordId}`);
    const level = String(select?.value || 'member');
    if (!discordId) return;
    if (discordId === getDiscordIdentity().discordId) return alert('You cannot change your own access.');
    if (!confirm(`Set ${discordId} to ${directorAccessLabel(level)} access?`)) return;
    const { error } = await supabaseClient.rpc('director_set_staff_access', { p_discord_id: discordId, p_access_level: level });
    if (error) return alert(error.message);
    await loadAccessRequests();
    await loadStaff();
    await loadRosterData();
    await loadAccess();
    await searchDirectorStaffDirectory(document.getElementById('directorStaffSearchInput')?.value || '');
}

function renderAccessRequestsView() {
    const pending = (accessRequests || []).filter(r => String(r.status || "pending").toLowerCase() === "pending");
    const processed = (accessRequests || []).filter(r => String(r.status || "pending").toLowerCase() !== "pending");
    const grantLevels = availableGrantLevels();
    const levelLabel = level => String(level || "public").toUpperCase();

    const requestCard = r => {
        const status = String(r.status || "pending").toLowerCase();
        const created = r.created_at ? formatOpsDateTime(r.created_at) : "";
        const requested = levelLabel(r.requested_access_level || r.access_level);
        const identity = r.display_name || r.discord_username || r.username || r.discord_id || "Unknown Discord account";
        return `<article class="ops-card access-request-card">
            <div class="ops-card-head">
                <div><h3>${escapeHtml(String(identity))}</h3><small>${escapeHtml(String(r.discord_id || "Discord account"))}</small></div>
                <span class="mode-badge ${status === "pending" ? "staff-mode" : "player-mode"}">${escapeHtml(levelLabel(status))}</span>
            </div>
            <div class="ops-grid compact-ops-grid">
                <div><span>Requested</span><strong>${escapeHtml(requested)}</strong></div>
                <div><span>Submitted</span><strong>${escapeHtml(created || "Unknown")}</strong></div>
                ${r.reason ? `<div><span>Reason</span><strong>${escapeHtml(String(r.reason))}</strong></div>` : ""}
            </div>
            ${status === "pending" ? `<div class="ops-actions">
                ${grantLevels.map(([value, label]) => `<button class="primary-button" onclick="approveAccessRequest('${escapeAttribute(r.id)}','${escapeAttribute(value)}')">Approve ${escapeHtml(label)}</button>`).join("")}
                <button class="secondary-button" onclick="rejectAccessRequest('${escapeAttribute(r.id)}')">Reject</button>
            </div>` : ""}
        </article>`;
    };

    return `<div class="ops-view access-requests-view">
        ${opsCard("Access Requests", `<p class="ops-muted">Director approval queue. Direct grants still follow the security chain: ADM → AUX, Management → ADM, Director → any non-Director level.</p>`, `<span class="mode-badge staff-mode">${pending.length} PENDING</span>`)}
        ${pending.length ? pending.map(requestCard).join("") : `<div class="ops-card"><h3>No pending requests</h3><p class="ops-muted">There are currently no staff access requests waiting for approval.</p></div>`}
        ${processed.length ? `<details class="ops-card"><summary>Processed requests (${processed.length})</summary><div class="access-history-list">${processed.slice(0, 100).map(requestCard).join("")}</div></details>` : ""}
    </div>`;
}


function renderOpsHelpers() {
    const helpers = Array.isArray(ops.helpers) ? ops.helpers : [];
    const eventOptions = (events || [])
        .filter(e => e && e.id && e.status !== "cancelled")
        .sort((a,b) => String(b.event_date || "").localeCompare(String(a.event_date || "")))
        .map(e => `<option value="${escapeAttribute(e.id)}">${escapeHtml(e.title || "Untitled event")} · ${escapeHtml(e.event_date || "Date TBC")} ${escapeHtml(String(e.start_time || "").slice(0,5))}</option>`)
        .join("");
    const staffOptions = (staff || [])
        .filter(s => s && s.id)
        .slice()
        .sort((a,b) => String(a.name || "").localeCompare(String(b.name || "")))
        .map(s => `<option value="${escapeAttribute(s.id)}">${escapeHtml(s.name || "Unnamed staff member")}${s.discord_id ? ` · ${escapeHtml(s.discord_id)}` : ""}</option>`)
        .join("");
    const rows = helpers.map(h => {
        const event = h.events || (events || []).find(e => String(e.id) === String(h.event_id));
        const member = h.staff || (staff || []).find(s => String(s.id) === String(h.staff_id));
        return `<tr>
            <td><strong>${escapeHtml(event?.title || "Event unavailable")}</strong><small>${escapeHtml(event?.event_date || "")} ${escapeHtml(String(event?.start_time || "").slice(0,5))}</small></td>
            <td>${escapeHtml(member?.name || "Staff member unavailable")}</td>
            <td>${escapeHtml(h.note || "")}</td>
            <td>${formatOpsDateTime(h.created_at)}</td>
            ${canManage() ? `<td><button type="button" class="secondary-button helper-remove" data-id="${escapeAttribute(h.id)}">Remove</button></td>` : ""}
        </tr>`;
    }).join("");
    return `${opsErrorNotice("helpers")}
        ${canManage() ? opsCard("Assign event helpers", `<form id="helperForm" class="ops-form helper-assignment-form">
            <label>Event<select name="event_id" required><option value="">Choose an event</option>${eventOptions}</select></label>
            <label>Helper<select name="staff_id" required><option value="">Choose a staff member</option>${staffOptions}</select></label>
            <label>Notes (optional)<input name="note" maxlength="300" placeholder="What are they helping with?"></label>
            <button class="primary-button" type="submit">Assign helper</button>
            <small>Helpers are attached to the selected event and appear in its helper list.</small>
        </form>`) : ""}
        ${opsCard("Assigned helpers", helpers.length ? `<div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>Event</th><th>Helper</th><th>Notes</th><th>Assigned</th>${canManage() ? "<th></th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="ops-empty">No helpers have been assigned yet.</div>`)}
    `;
}

async function removeOpsHelper(id) {
    if (!canManage() || !id) return;
    if (!confirm("Remove this helper assignment?")) return;
    const { error } = await supabaseClient.from("ops_helpers").delete().eq("id", id);
    if (error) return alert(error.message);
    await loadOpsData();
    render();
}

function renderOpsViewHtml() {
    switch (opsView) {
        case "dashboard": return renderOpsDashboard();
        case "command-dashboard": return renderInteractionDashboard();
        case "interactions-leaderboard": return renderInteractionLeaderboard();
        case "hall-of-fame": return renderHallOfFame();
        case "personal-dashboard": return renderPersonalDashboard();
        case "staff-roster": return renderStaffRoster();
        case "event-suggestions": return renderEventSuggestions();
        case "actions": return renderOpsActionsHub();
        case "tracker": return renderOpsTracker();
        case "points": return renderOpsPoints();
        case "host-event": return renderHostEventPlanner();
        case "reductions": return renderOpsReductions();
        case "logs": return renderOpsLogs();
        case "security": return renderOpsSecurity();
        case "prizes": return renderOpsPrizes();
        case "helpers": return renderOpsHelpers();
        case "access": return renderAccessRequestsView();
        case "director-staff": return renderDirectorStaffSearch();
        case "host-action": return renderHostAction();
        case "action-schedule": return renderActionSchedule();
        case "action-tracker": return renderActionTracker();
        case "action-br-tracker": return renderActionBrTracker();
        case "action-log": return renderActionLog();
        case "action-stats": return renderActionStats();
        case "action-leaderboard": return renderActionLeaderboard();
        case "action-goals": return renderActionGoals();
        default: return `<div class="ops-card"><h3>Schedule</h3><p>Use the Schedule tab.</p></div>`;
    }
}

function getUpcomingDashboardEvents(limit = 8) {
    const now = new Date();
    const today = formatDate(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = formatDate(tomorrow);

    const candidates = (events || [])
        .filter(e => !e.is_meeting && e.status !== "cancelled")
        .map(e => {
            const dateKey = String(e.event_date || "");
            if (!dateKey) return null;
            const start = new Date(`${dateKey}T${String(e.start_time || "00:00").slice(0,5)}:00`);
            const end = new Date(`${dateKey}T${String(e.end_time || e.start_time || "00:00").slice(0,5)}:00`);
            if (Number.isNaN(start.getTime())) return null;
            // Only show events that have not started yet. The full Schedule page
            // remains the place to inspect an event that is currently running.
            if (start < now) return null;
            return { ...e, _dashboardStart: start, _dashboardEnd: end, _dateKey: dateKey };
        })
        .filter(Boolean)
        .sort((a, b) => a._dashboardStart - b._dashboardStart);

    // Keep the dashboard rolling forward. The date variables above are useful
    // for readability and future expansion, while the sorted event list also
    // naturally carries into tomorrow and later dates if needed.
    void today;
    void tomorrowKey;
    return candidates.slice(0, limit);
}

function dashboardEventDateLabel(event) {
    const now = new Date();
    const eventDate = String(event.event_date || "");
    const today = formatDate(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = formatDate(tomorrow);
    if (eventDate === today) return "Today";
    if (eventDate === tomorrowKey) return "Tomorrow";
    const date = new Date(`${eventDate}T00:00:00`);
    return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function renderOpsDashboard() {
    const upcomingEvents = getUpcomingDashboardEvents(8);
    const completed = (allEvents || []).filter(e => !e.is_meeting && isEventCompleted(e));
    const counts = {};
    completed.forEach(e => {
        const key = e.title || e.event_types?.name || "Event";
        counts[key] = (counts[key] || 0) + 1;
    });
    const leaderboard = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10);
    const totalPoints = ops.points.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const activeReductions = ops.reductions.filter(r => r.active !== false).length;

    const totals = {};
    ops.points.forEach(p => {
        const id = p.staff_id;
        if (!totals[id]) totals[id] = { name: p.staff?.name || "Unknown", total: 0 };
        totals[id].total += Number(p.amount || 0);
    });
    const pointRows = Object.values(totals).sort((a,b)=>b.total-a.total);

    const upcomingBody = upcomingEvents.length
        ? `<div class="ops-list dashboard-upcoming-list">${upcomingEvents.map(e => `
            <div class="ops-row dashboard-upcoming-row">
                <div>
                    <b>${escapeHtml(e.title)}</b>
                    <small>${dashboardEventDateLabel(e)} · ${formatTime(e.start_time)} - ${formatTime(e.end_time)}</small>
                </div>
                <span class="ops-pill">${escapeHtml(e.event_types?.name || "Event")}</span>
            </div>`).join("")}</div>`
        : `<div class="ops-empty">No upcoming events are currently scheduled.</div>`;

    const pointsBody = pointRows.length
        ? `<div class="leaderboard">${pointRows.slice(0,10).map((r,i)=>`<div class="leader-row"><span class="rank">${i+1}</span><b>${escapeHtml(r.name)}</b><strong>${r.total}</strong></div>`).join("")}</div>`
        : `<div class="ops-empty">No points recorded yet.</div>`;

    const adjustPointsBody = canManage()
        ? `<form id="pointsForm" class="ops-form">
            <label>Team<select name="team" required><option value="actions">Actions</option><option value="interactions">Interactions</option></select></label>
            <select name="staff_id" required><option value="">Select staff</option>${staff.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select>
            <input name="amount" type="number" min="-25" max="25" required placeholder="Points (-25 to 25)">
            <input name="reason" maxlength="200" required placeholder="Reason">
            <button class="primary-button">Apply adjustment</button>
            <small>Maximum adjustment: 25 points.</small>
        </form>`
        : `<div class="ops-empty">Management access required.</div>`;

    return `${opsErrorNotice("tracker")}${opsErrorNotice("points")}
        <div class="ops-stats-grid">
            <div class="ops-stat"><span>Upcoming</span><strong>${upcomingEvents.length}</strong><small>next scheduled events</small></div>
            <div class="ops-stat"><span>Completed</span><strong>${completed.length}</strong><small>completed events</small></div>
            <div class="ops-stat"><span>Staff</span><strong>${staff.length}</strong><small>active staff</small></div>
            <div class="ops-stat"><span>Points</span><strong>${totalPoints}</strong><small>recorded adjustments</small></div>
            <div class="ops-stat"><span>Reductions</span><strong>${activeReductions}</strong><small>active records</small></div>
        </div>
        <div class="ops-grid-two">
            ${opsCard("Upcoming events", upcomingBody, `<span class="ops-subtle">Rolling from the current time</span>`)}
            ${opsCard("Completed event leaderboard", leaderboard.length ? `<div class="ops-list leaderboard-list">${leaderboard.map(([name,count],i)=>`<div class="ops-row"><div><b>#${i+1} · ${escapeHtml(name)}</b><small>Completed ${count} time${count===1?"":"s"}</small></div><span class="ops-pill">${count}</span></div>`).join("")}</div>` : `<div class="ops-empty">No completed events yet. Humanity survives another day.</div>`)}
        </div>
        <div class="ops-grid-two dashboard-points-section">
            ${opsCard("Points leaderboard", pointsBody, `<span class="ops-subtle">Top staff by total points</span>`)}
            ${opsCard("Adjust points", adjustPointsBody, `<span class="ops-subtle">ADM+ only</span>`)}
        </div>`;
}

function renderOpsActionsHub() {
    const pointsCard = canManage() ? opsCard("Adjust staff points", `<form id="actionsPointsForm" class="ops-form"><label>Team<select name="team" required><option value="actions">Actions</option><option value="interactions">Interactions</option></select></label><select name="staff_id" required><option value="">Select staff</option>${staff.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select><input name="amount" type="number" min="-25" max="25" required placeholder="Points (-25 to 25)"><input name="reason" maxlength="200" required placeholder="Reason"><button class="primary-button">Apply adjustment</button><small>ADM+ only · maximum adjustment 25 points.</small></form>`) : "";
    return `<div class="ops-grid-two">
        ${opsCard("Actions & Interactions", `<div class="action-hub-grid"><button class="hub-action" onclick="switchOpsView('tracker')"><b>Tracker</b><small>Staff activity and operational work</small></button><button class="hub-action" onclick="switchOpsView('helpers')"><b>Helpers</b><small>Assign additional staff helpers to events</small></button><button class="hub-action" onclick="switchOpsView('staff-roster')"><b>Manage Team Rosters</b><small>Allocate, move and edit Actions / Interactions staff</small></button></div>`)}
        ${pointsCard || opsCard("Staff tools", `<div class="ops-empty">Management tools are only available to ADM and above.</div>`)}
    </div>`;
}

function renderOpsTracker() {
    const teams = [...new Set(ops.tracker.map(x => x.team).filter(Boolean))].sort();
    return `${opsErrorNotice("tracker")}
        <div class="ops-toolbar"><select id="trackerTeamFilter"><option value="all">All teams</option>${teams.map(t=>`<option value="${escapeAttribute(t)}">${escapeHtml(t)}</option>`).join("")}</select><button class="primary-button" id="openTrackerAdd">+ Add activity</button></div>
        ${opsCard("Activity tracker", ops.tracker.length ? `<div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>Staff</th><th>Team</th><th>Type</th><th>Status</th><th>When</th></tr></thead><tbody>${ops.tracker.map(x=>`<tr data-team-row="${escapeAttribute(x.team || "")}"><td>${escapeHtml(x.staff?.name || "Unknown")}</td><td>${escapeHtml(x.team || "")}</td><td>${escapeHtml(x.activity_type || "Activity")}</td><td><span class="ops-pill">${escapeHtml(x.status || "Logged")}</span></td><td>${formatOpsDateTime(x.created_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="ops-empty">No tracker entries yet.</div>`)}
    `;
}

function renderOpsPoints() {
    const totals = {};
    ops.points.forEach(p => { const id=p.staff_id; if(!totals[id]) totals[id]={name:p.staff?.name||"Unknown", total:0}; totals[id].total += Number(p.amount||0); });
    const rows = Object.values(totals).sort((a,b)=>b.total-a.total);
    return `${opsErrorNotice("points")}
        <div class="ops-grid-two">
            ${opsCard("Leaderboard", rows.length ? `<div class="leaderboard">${rows.map((r,i)=>`<div class="leader-row"><span class="rank">${i+1}</span><b>${escapeHtml(r.name)}</b><strong>${r.total}</strong></div>`).join("")}</div>` : `<div class="ops-empty">No points recorded yet.</div>`)}
            ${canManage() ? opsCard("Adjust points", `<form id="pointsForm" class="ops-form"><label>Team<select name="team" required><option value="actions">Actions</option><option value="interactions">Interactions</option></select></label><select name="staff_id" required><option value="">Select staff</option>${staff.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select><input name="amount" type="number" min="-25" max="25" required placeholder="Points (-25 to 25)"><input name="reason" maxlength="200" required placeholder="Reason"><button class="primary-button">Apply adjustment</button><small>Maximum adjustment: 25 points.</small></form>`) : `<div class="ops-card"><h3>Adjust points</h3><div class="ops-empty">Management access required.</div></div>`}
        </div>`;
}

function hostEventPool() {
    return [
        "Arena Annihilation","Bar Fight","BMX Sprint","Boxes","Breaks Are Gone","Buggy Blitz","Bumper Cars","Cargo FFA","Compound FFA","Cops & Robbers","Crossy Road","Dead Man's Dash","Dirty Derby","Dress to Impress","Factory of Fear","Family Fortunes","Find the Animal","Football Trivia","Fortune's Choice","Grand Prix","Guess the Song","Got-A-Reason","Go-Kart Race","Hide My Ride","Higher or Lower","Hide-or-Die Chicken Coop","Hide-or-Die Chinatown","Hide-or-Die Hospital","Hide-or-Die University","KNG Got Talent","KNG Trivia","Long Haul Championship","Monster Truck Gauntlet","Musical Cars","Musical Statues","Need for Speed","Phantoms vs Runners","Pop Quiz","Ramps","Rubber Dinghy Rapids","Sandy Seeking","Scavenger Hunt","Simon Says","Slippy Slide","Subway Surfers","Taxi Dash","Harbour Havoc","Would You Rather","Word War","Clown Survival","Deadman's Pit","Ghost Rider Rally","Haunted Hospital","Headless Horseman","Infected","Scrapyard Showdown","The Haunting Grounds","The Slasher","Chemist Clash","KNG Boxing"
    ];
}
function hostManualOnlyEvents() { return ["Club 77", "Vanilla"]; }
function hostAllEventChoices() { return [...hostEventPool(), ...hostManualOnlyEvents()]; }
function hostTimeToMinutes(value) { const [h,m] = String(value || "00:00").split(":").map(Number); return (h * 60) + m; }
function hostMinutesToTime(minutes) { const h = Math.floor(minutes / 60) % 24; const m = minutes % 60; return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`; }
function hostSlotOccupied(date, start, end, ignoreId = null) {
    // Meetings are a separate calendar category, not entertainment booking slots.
    // Club 77, Vanilla and F3 entertainment events may run alongside meetings.
    // Only another non-meeting entertainment event blocks this slot.
    const s = hostTimeToMinutes(start), e = hostTimeToMinutes(end);
    return (allEvents || []).some(ev => {
        if (ignoreId && String(ev.id) === String(ignoreId)) return false;
        if (ev.event_date !== date || ev.status === "cancelled" || ev.is_meeting === true) return false;
        const es = hostTimeToMinutes(ev.start_time), ee = hostTimeToMinutes(ev.end_time);
        return es < e && ee > s;
    });
}
function hostTypeIdFor(title) {
    const lower = String(title || "").toLowerCase();
    if (lower === "club 77" || lower === "vanilla") return eventTypes.find(t => String(t.name||"").toLowerCase() === "party")?.id || eventTypes.find(t => String(t.name||"").toLowerCase() === "event")?.id;
    return eventTypes.find(t => String(t.name||"").toLowerCase() === "event")?.id || eventTypes[0]?.id;
}
function renderHostEventPlanner() {
    const date = hostPlannerDate || formatDate(new Date());
    const todayEvents = (allEvents || []).filter(e => e.event_date === date && e.status !== "cancelled").sort((a,b)=>String(a.start_time).localeCompare(String(b.start_time)));
    const canEdit = canManage();
    return `${opsErrorNotice("host-event")}
        <div class="host-event-toolbar"><div><span class="host-eyebrow">KNG ENTERTAINMENT</span><h2>Host an Event</h2><p>Build the schedule, protect planned slots, then change anything manually when the schedule inevitably develops opinions.</p></div>${canEdit ? `<div class="host-toolbar-buttons"><button class="primary-button" onclick="randomiseHostSchedule()">🎲 Randomise Empty Slots</button><button class="secondary-button" onclick="toggleHostPanel('plannedHostPanel')">📅 Add Planned Event</button><button class="secondary-button" onclick="toggleHostPanel('manualHostPanel')">➕ Add Event</button></div>` : ""}</div>
        <div id="plannedHostPanel" class="host-control-panel" hidden><div class="host-control-head"><div><b>Planned / Protected Event</b><small>Daily, weekly or biweekly events lock their slots so the randomiser cannot fill them.</small></div><button class="secondary-button small" onclick="toggleHostPanel('plannedHostPanel')">Close</button></div><form id="plannedHostForm" class="host-form-grid"><input name="title" maxlength="120" placeholder="Event name" required><select name="type_id" required>${eventTypes.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}</select><input name="event_date" type="date" value="${date}" required><input name="start_time" type="time" value="18:00" required><input name="end_time" type="time" value="18:30" required><select name="repeat"><option value="none">One time</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option></select><input name="repeat_until" type="date" value="${formatDate(new Date(Date.now()+90*86400000))}" required><input name="description" maxlength="500" placeholder="Optional note"><button class="primary-button" type="submit">Create &amp; Protect Slot(s)</button></form><div id="plannedHostError" class="form-error"></div></div>
        <div id="manualHostPanel" class="host-control-panel" hidden><div class="host-control-head"><div><b>Manual Event</b><small>Club 77 and Vanilla are available here but are never chosen by the randomiser.</small></div><button class="secondary-button small" onclick="toggleHostPanel('manualHostPanel')">Close</button></div><form id="manualHostForm" class="host-form-grid"><select name="title" required>${hostAllEventChoices().map(x=>`<option value="${escapeAttribute(x)}">${escapeHtml(x)}</option>`).join("")}</select><input name="event_date" type="date" value="${date}" required><input name="start_time" type="time" value="18:00" required><input name="end_time" type="time" value="18:30" required><input name="description" maxlength="500" placeholder="Optional note"><label class="host-check"><input type="checkbox" name="locked"> Protect this slot from the randomiser</label><button class="primary-button" type="submit">Add Event</button></form><div id="manualHostError" class="form-error"></div></div>
        <div class="host-randomiser-card"><div><b>Randomiser</b><small>Only empty slots are filled. Existing events are never overwritten by the randomiser.</small></div><div class="host-randomiser-controls"><label class="host-date-label">View / randomise date<input id="hostRandomDate" type="date" value="${date}" onchange="setHostPlannerDate(this.value)"></label><input id="hostRandomStart" type="time" value="18:00"><input id="hostRandomEnd" type="time" value="23:30"><select id="hostRandomInterval"><option value="30">30 minute slots</option><option value="60">60 minute slots</option></select></div></div>
        <div class="host-schedule-card"><div class="host-section-head"><div><h3>Schedule</h3><small>Every slot can still be edited after randomisation.</small></div><span class="ops-pill">${todayEvents.length} scheduled</span></div><div id="hostScheduleList" class="host-slot-list">${todayEvents.length ? todayEvents.map(e => hostRenderSlot(e)).join("") : `<div class="ops-empty">No events are scheduled for today yet.</div>`}</div></div>
        <div class="host-rules-grid"><div><b>🎲 Random</b><small>${hostEventPool().length} event choices</small></div><div><b>🎉 Manual only</b><small>Club 77 + Vanilla</small></div><div><b>🔒 Protected</b><small>Planned slots cannot be overwritten by the randomiser</small></div><div><b>✏️ Editable</b><small>You can change any slot after randomisation</small></div></div>`;
}
function hostEventStartDate(e) {
    const date = String(e.event_date || "");
    const time = String(e.start_time || "00:00").slice(0, 5);
    return new Date(`${date}T${time}:00`);
}

function hostCanUnclaim(e) {
    if (!currentUser || String(e.host_claimed_by || "") !== String(currentUser.id || "")) return false;
    const start = hostEventStartDate(e).getTime();
    if (!Number.isFinite(start)) return false;
    return Date.now() < start - (60 * 60 * 1000);
}

function hostRenderSlot(e) {
    const source = e.host_source === "random" ? "Random" : e.host_source === "planned" ? "Planned / Protected" : "Manual / Existing";
    const locked = e.host_locked || e.host_source === "planned";
    const claimed = Boolean(e.host_claimed_by || e.host_claimed_discord);
    const mine = claimed && currentUser && String(e.host_claimed_by || "") === String(currentUser.id || "");
    const claimedStaff = (staff || []).find(s => String(s.discord_id || '') === String(e.host_claimed_discord || '') || String(s.id || '') === String(e.host_claimed_by || ''));
    const claimedDisplayName = mine ? getKngDisplayName() : (e.host_claimed_name || claimedStaff?.name || "Staff");
    const claimLabel = claimed ? `Claimed by ${escapeHtml(claimedDisplayName)}` : "";
    const claimButton = currentUser && permissionRank() >= 1 && !claimed ? `<button class="primary-button small host-claim-btn" onclick="claimHostSlot('${e.id}')">🎤 Claim</button>` : "";
    const unclaimButton = mine && hostCanUnclaim(e) ? `<button class="secondary-button small host-unclaim-btn" onclick="unclaimHostSlot('${e.id}')">↩ Unclaim</button>` : "";
    const unclaimLocked = mine && !hostCanUnclaim(e) ? `<span class="host-unclaim-locked" title="Unclaiming closes one hour before the event starts">🔒 Locked</span>` : "";
    return `<div class="host-slot ${locked ? "host-slot-locked" : ""}"><div class="host-slot-time">${escapeHtml(String(e.start_time||"").slice(0,5))}<small>${escapeHtml(String(e.end_time||"").slice(0,5))}</small></div><div class="host-slot-main"><b>${escapeHtml(e.title)}</b><small>${escapeHtml(source)}${e.description ? ` · ${escapeHtml(e.description)}` : ""}${claimLabel ? ` · <span class="host-claimed">${claimLabel}</span>` : ""}</small></div><div class="host-slot-actions">${locked ? `<span class="host-lock">🔒</span>` : ""}${claimButton}${unclaimButton}${unclaimLocked}${canManage() ? `<button class="secondary-button small" onclick="openHostEdit('${e.id}')">Edit</button>` : ""}</div></div>`;
}

async function claimHostSlot(id) {
    if (!currentUser || permissionRank() < 1) return alert("You must be signed in as KNG staff to claim an event.");
    const { data, error } = await supabaseClient.rpc("claim_event_host_slot", { p_event_id: id, p_display_name: getKngDisplayName() });
    if (error) return alert(error.message);
    if (data === false) return alert("That event has already been claimed by another staff member.");
    await loadEvents();
    render();
}

async function unclaimHostSlot(id) {
    if (!currentUser) return;
    const event = (allEvents || []).find(e => String(e.id) === String(id));
    if (event && !hostCanUnclaim(event)) return alert("You can only unclaim an event more than one hour before it starts.");
    const { data, error } = await supabaseClient.rpc("unclaim_event_host_slot", { p_event_id: id });
    if (error) return alert(error.message);
    if (data === false) return alert("You cannot unclaim this event.");
    await loadEvents();
    render();
}

function setHostPlannerDate(value){ if(!value)return; hostPlannerDate=value; try{localStorage.setItem("kng.hostPlannerDate",value);}catch(_){} render(); }
function toggleHostPanel(id) { const el=document.getElementById(id); if(el) el.hidden=!el.hidden; }
async function submitPlannedHostEvent(e){ e.preventDefault(); if(!canManage())return; const cooldown=enforceCooldown("event-create",30); if(cooldown)return alert(`Event creation is on a 30-second cooldown. Try again in ${cooldown}s.`); const d=Object.fromEntries(new FormData(e.target).entries()), err=document.getElementById("plannedHostError"); err.textContent=""; if(d.end_time<=d.start_time)return err.textContent="End time must be later than start time."; if(d.repeat!=="none"&&d.repeat_until<d.event_date)return err.textContent="Repeat until must be on or after the first date."; const dates=buildRecurringDates(d.event_date,d.repeat,d.repeat_until); const blocked=dates.filter(x=>hostSlotOccupied(x,d.start_time,d.end_time)); if(blocked.length)return err.textContent=`These dates already have an event in that slot: ${blocked.join(", ")}`; const group=dates.length>1?crypto.randomUUID():null; const rows=dates.map(x=>({title:d.title.trim(),event_type_id:d.type_id,event_date:x,start_time:d.start_time,end_time:d.end_time,description:d.description?.trim()||null,location:null,staff_required:0,visibility:"public",recurrence_group_id:group,recurrence_rule:d.repeat==="none"?null:d.repeat,status:"scheduled",is_meeting:false,created_by:currentUser.id,updated_by:currentUser.id,host_source:"planned",host_locked:true})); const {error}=await supabaseClient.from("events").insert(rows); if(error)return err.textContent=error.message; await writeAudit("host.planned_created",{title:d.title,dates,repeat:d.repeat}); await loadEvents(); render(); }
async function submitManualHostEvent(e){ e.preventDefault(); if(!canManage())return; const cooldown=enforceCooldown("event-create",30); if(cooldown)return alert(`Event creation is on a 30-second cooldown. Try again in ${cooldown}s.`); const d=Object.fromEntries(new FormData(e.target).entries()), err=document.getElementById("manualHostError"); err.textContent=""; if(d.end_time<=d.start_time)return err.textContent="End time must be later than start time."; if(hostSlotOccupied(d.event_date,d.start_time,d.end_time))return err.textContent="That time slot already has an event. Edit the existing slot instead."; const typeId=hostTypeIdFor(d.title); if(!typeId)return err.textContent="No usable Event type exists in the database."; const payload={title:d.title,event_type_id:typeId,event_date:d.event_date,start_time:d.start_time,end_time:d.end_time,description:d.description?.trim()||null,location:null,staff_required:0,visibility:"public",recurrence_group_id:null,recurrence_rule:null,status:"scheduled",is_meeting:false,created_by:currentUser.id,updated_by:currentUser.id,host_source:"manual",host_locked:d.locked==="on"}; const {error}=await supabaseClient.from("events").insert(payload); if(error)return err.textContent=error.message; await writeAudit("host.manual_created",payload); await loadEvents(); render(); }
async function randomiseHostSchedule(){ if(!canManage())return; const cooldown=enforceCooldown("event-create",30); if(cooldown)return alert(`Event creation is on a 30-second cooldown. Try again in ${cooldown}s.`); const date=document.getElementById("hostRandomDate")?.value,start=document.getElementById("hostRandomStart")?.value||"18:00",end=document.getElementById("hostRandomEnd")?.value||"23:30",interval=Math.max(30,Number(document.getElementById("hostRandomInterval")?.value||30)); if(!date||hostTimeToMinutes(end)<=hostTimeToMinutes(start))return alert("Choose a valid randomiser time range."); const typeId=hostTypeIdFor("Event"); if(!typeId)return alert("No Event type exists in the database."); const choices=hostEventPool(),rows=[]; let previous=""; for(let m=hostTimeToMinutes(start);m+interval<=hostTimeToMinutes(end);m+=interval){const a=hostMinutesToTime(m),b=hostMinutesToTime(m+interval);if(hostSlotOccupied(date,a,b))continue;const available=choices.filter(x=>x!==previous),title=available[Math.floor(Math.random()*available.length)];previous=title;rows.push({title,event_type_id:typeId,event_date:date,start_time:a,end_time:b,description:"Randomised by KNG Entertainment Host an Event",location:null,staff_required:0,visibility:"public",recurrence_group_id:null,recurrence_rule:null,status:"scheduled",is_meeting:false,created_by:currentUser.id,updated_by:currentUser.id,host_source:"random",host_locked:false});} if(!rows.length)return alert("There are no empty slots in that range to randomise."); const {error}=await supabaseClient.from("events").insert(rows); if(error)return alert(error.message); await writeAudit("host.randomised",{date,start,end,interval,created:rows.map(r=>r.title)}); await loadEvents(); render(); }
function openHostEdit(id){ if(!canManage())return; const e=allEvents.find(x=>String(x.id)===String(id)); if(!e)return; const titleOptions=hostAllEventChoices().map(x=>`<option value="${escapeAttribute(x)}" ${x===e.title?"selected":""}>${escapeHtml(x)}</option>`).join(""); showModal(`<div class="modal"><div class="modal-header"><div><span class="modal-eyebrow">Host an Event</span><h2>Edit Event Slot</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><form id="hostEditForm" class="ops-form"><label>Event<select name="title">${titleOptions}</select></label><label>Date<input name="event_date" type="date" value="${escapeAttribute(e.event_date)}" required></label><label>Start<input name="start_time" type="time" value="${escapeAttribute(String(e.start_time||"").slice(0,5))}" required></label><label>End<input name="end_time" type="time" value="${escapeAttribute(String(e.end_time||"").slice(0,5))}" required></label><label>Note<input name="description" maxlength="500" value="${escapeAttribute(e.description||"")}" placeholder="Optional note"></label><label class="host-check"><input type="checkbox" name="locked" ${e.host_locked||e.host_source==="planned"?"checked":""}> Protect this slot from randomiser</label><div id="hostEditError" class="form-error"></div><div class="modal-footer"><button type="button" class="secondary-button" onclick="closeModal()">Cancel</button><button type="button" class="danger-button" onclick="deleteHostEvent('${e.id}')">Delete</button><button type="submit" class="primary-button">Save Changes</button></div></form></div>`); document.getElementById("hostEditForm")?.addEventListener("submit",async ev=>{ev.preventDefault();const d=Object.fromEntries(new FormData(ev.target).entries()),err=document.getElementById("hostEditError");err.textContent="";if(d.end_time<=d.start_time)return err.textContent="End time must be later than start time.";if(hostSlotOccupied(d.event_date,d.start_time,d.end_time,e.id))return err.textContent="That new slot overlaps another event.";const typeId=hostTypeIdFor(d.title);const payload={title:d.title,event_type_id:typeId||e.event_type_id,event_date:d.event_date,start_time:d.start_time,end_time:d.end_time,description:d.description?.trim()||null,updated_by:currentUser.id,host_locked:d.locked==="on"};const {error}=await supabaseClient.from("events").update(payload).eq("id",e.id);if(error)return err.textContent=error.message;await writeAudit("host.slot_updated",{event_id:e.id,title:d.title,date:d.event_date,start:d.start_time,end:d.end_time});closeModal();await loadEvents();render();}); }
async function deleteHostEvent(id){if(!canManage()||!confirm("Delete this event slot?"))return;const {error}=await supabaseClient.from("events").delete().eq("id",id);if(error)return alert(error.message);await writeAudit("host.slot_deleted",{event_id:id});closeModal();await loadEvents();render();}

function renderOpsReductions() {
    return `${opsErrorNotice("reductions")}
        ${canManage() ? opsCard("Add reduction", `<form id="reductionForm" class="ops-form"><select name="staff_id" required><option value="">Select staff</option>${staff.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}</select><input name="amount" type="number" min="1" required placeholder="Amount"><input name="reason" maxlength="200" required placeholder="Reason"><button class="primary-button">Add reduction</button></form>`) : ""}
        ${opsCard("Reduction history", ops.reductions.length ? `<div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>Staff</th><th>Amount</th><th>Reason</th><th>Status</th><th>Date</th></tr></thead><tbody>${ops.reductions.map(r=>`<tr><td>${escapeHtml(r.staff?.name||"Unknown")}</td><td>${Number(r.amount||0)}</td><td>${escapeHtml(r.reason||"")}</td><td>${r.active===false?"Closed":"Active"}</td><td>${formatOpsDateTime(r.created_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="ops-empty">No reductions recorded.</div>`)}
    `;
}

function renderOpsLogs() {
    return `<div class="ops-empty">This page has been removed.</div>`;
}

function renderOpsSecurity() {
    const securityEvents = [...(ops.security || [])].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    return `${opsErrorNotice("security")}
        <div class="ops-grid-two">
            ${canManage() ? opsCard("Crashout timeout", `<form id="timeoutForm" class="ops-form"><textarea name="emails" rows="5" placeholder="Paste account email(s) here. They will not appear in account lists." required></textarea><input name="minutes" type="number" min="1" max="10080" value="30" required><input name="reason" maxlength="200" placeholder="Reason" required><button class="danger-button">Timeout everyone</button><small>Manual timeout. Automatic crashout protection is ${Number(crashoutSettings.max_removals)} removals in ${Number(crashoutSettings.window_minutes)} minutes, then ${Number(crashoutSettings.timeout_minutes)} minutes timed out.</small></form>`) : ""}
            ${canManage() ? opsCard("Kick off / remove from team", `<form id="blockForm" class="ops-form"><textarea name="emails" rows="5" placeholder="Paste account email(s) here. They will not appear in account lists." required></textarea><input name="reason" maxlength="200" value="Inactivity" placeholder="Reason"><button class="danger-button">Kick off &amp; block access</button><small>Kick-offs default to <b>Inactivity</b>. Crashout protection stops an actor exceeding the configured removal limit.</small></form>`) : ""}
            ${isDirector() ? opsCard("Crashout protection settings", `<form id="crashoutSettingsForm" class="ops-form"><label>Maximum removals<input name="max_removals" type="number" min="1" max="50" value="${Number(crashoutSettings.max_removals)}" required></label><label>Window (minutes)<input name="window_minutes" type="number" min="1" max="1440" value="${Number(crashoutSettings.window_minutes)}" required></label><label>Timeout (minutes)<input name="timeout_minutes" type="number" min="1" max="10080" value="${Number(crashoutSettings.timeout_minutes)}" required></label><button class="primary-button">Save Crashout Limit</button></form>`) : ""}
        </div>
        ${opsCard("Active timeouts", (ops.timeouts||[]).length ? `<div class="ops-list">${ops.timeouts.filter(t=>new Date(t.expires_at)>new Date()).map(t=>`<div class="ops-row"><div><b>Timed-out account</b><small>${escapeHtml(t.reason||"")} · until ${formatOpsDateTime(t.expires_at)}</small></div><span class="ops-pill">Timed out</span></div>`).join("")}</div>` : `<div class="ops-empty">No active timeouts.</div>`)}
        ${opsCard("Blocked accounts", (ops.blocks||[]).length ? `<div class="ops-list">${ops.blocks.map(b=>`<div class="ops-row"><div><b>Blocked account</b><small>${escapeHtml(b.reason||"")} · ${formatOpsDateTime(b.created_at)}</small></div><button class="secondary-button unblock-account" data-email="${escapeAttribute(b.email)}">Unblock</button></div>`).join("")}</div>` : `<div class="ops-empty">No blocked accounts.</div>`)}
        ${opsCard("Security events", securityEvents.length ? `<div class="ops-list">${securityEvents.slice(0,100).map(x=>`<div class="ops-row"><div><b>${escapeHtml(x.event_type || "Security event")}</b><small>Staff · ${formatOpsDateTime(x.created_at)}</small></div><span class="ops-pill">${escapeHtml(x.severity || "Logged")}</span></div>`).join("")}</div>` : `<div class="ops-empty">No security events recorded.</div>`)}
    `;
}

function buildPrizeCommand(prize, discordId, reason='Event Winner') {
    if (!prize) return '';
    const template = String(prize.command_template || '!additem {discord_id} {code} {amount} {reason}');
    return template
        .replaceAll('{discord_id}', String(discordId || '').trim())
        .replaceAll('{name}', String(discordId || '').trim())
        .replaceAll('{code}', String(prize.code || '').trim())
        .replaceAll('{amount}', String(Number(prize.amount || 0)))
        .replaceAll('{reason}', String(reason || 'Event Winner').trim());
}

function renderOpsPrizes() {
    const wins=ops.prizeWins||[];
    const prizes=(ops.prizes||[]).filter(p=>p.active!==false).sort((a,b)=>Number(a.price||0)-Number(b.price||0)||Number(a.amount||0)-Number(b.amount||0));
    return `${opsErrorNotice("prizes")}
        <div class="ops-toolbar prize-tabs">
            <button class="integrated-nav-btn active">🏆 Prize Win</button>
            <button class="integrated-nav-btn" onclick="document.getElementById('commandVault')?.scrollIntoView({behavior:'smooth'})">⌘ Commands</button>
        </div>
        <div class="ops-grid-two prize-page-grid">
            ${canManage()?opsCard("Event Winner",`<form id="prizeWinPageForm" class="ops-form prize-win-page-form">
                <label>In-game ID<input name="discord_id" maxlength="50" placeholder="e.g. 33333" required></label>
                <label>Type<select name="prize_id" required><option value="">Select prize type</option>${prizes.map(p=>`<option value="${p.id}">${escapeHtml(p.label)}${p.price ? ` · ${Number(p.price).toLocaleString()} city cash` : ''}</option>`).join("")}</select></label>
                <label>Amount<input id="prizeWinAmount" name="amount" type="number" readonly placeholder="Auto-filled from type"></label>
                <label>Reason<input name="reason" maxlength="160" placeholder="e.g. Event Winner" required></label>
                <label>Command<div id="prizeWinPageCommand" class="command-preview">Enter the ID, choose a type and enter a reason.</div></label>
                <div class="prize-command-actions"><button type="button" class="secondary-button" id="copyPrizePageCommand" disabled>Copy command</button><button type="submit" class="primary-button">Record Win &amp; Generate Command</button></div>
                <div id="prizeWinPageError" class="form-error"></div>
            </form>`):""}
            ${opsCard("Prize catalogue",prizes.length?`<div class="prize-grid">${prizes.map(p=>`<div class="prize-card"><span>${escapeHtml(p.label)}</span><b>${escapeHtml(p.code)}</b><strong>${p.price ? `${Number(p.price).toLocaleString()} city cash` : Number(p.amount||0).toLocaleString()}</strong><small>${escapeHtml(buildPrizeCommand(p,'ID','Reason'))}</small></div>`).join("")}</div><small>Choose a prize type. The complete command is generated automatically from the saved command template.</small>`:`<div class="ops-empty">No prize types configured. Run the migration to seed the event prizes and item commands.</div>`)}
        </div>
        <div id="commandVault">${opsCard("Prize wins & command vault",wins.length?`<div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>In-game ID</th><th>Prize</th><th>Reason</th><th>Command</th><th>Done</th><th>Won</th></tr></thead><tbody>${wins.map(w=>`<tr class="${w.completed?"prize-win-complete":""}"><td>${escapeHtml(w.discord_id||"Unknown")}</td><td>${escapeHtml(w.ops_prizes?.label||"Prize")}</td><td>${escapeHtml(w.reason||"")}</td><td><code class="command-code">${escapeHtml(w.command||"")}</code></td><td><label class="prize-done"><input type="checkbox" class="prize-done-toggle" data-id="${w.id}" ${w.completed?"checked":""}><span>${w.completed?"Done":"Pending"}</span></label></td><td>${formatOpsDateTime(w.created_at)}</td></tr>`).join("")}</tbody></table></div>`:`<div class="ops-empty">No prize wins recorded yet.</div>`)}</div>`;
}

function bindOpsHandlers() {
    document.getElementById("trackerTeamFilter")?.addEventListener("change", e => {
        document.querySelectorAll("[data-team-row]").forEach(row => row.hidden = e.target.value !== "all" && row.dataset.team !== e.target.value);
    });
    document.getElementById("openTrackerAdd")?.addEventListener("click", openTrackerAddModal);
    document.getElementById("pointsForm")?.addEventListener("submit", submitPoints);
    document.getElementById("actionsPointsForm")?.addEventListener("submit", submitPoints);
    document.getElementById("plannedHostForm")?.addEventListener("submit", submitPlannedHostEvent);
    document.getElementById("manualHostForm")?.addEventListener("submit", submitManualHostEvent);
    document.getElementById("reductionForm")?.addEventListener("submit", submitReduction);
    document.getElementById("prizeForm")?.addEventListener("submit", submitPrize);
    bindPrizePageHandlers();
    document.getElementById("helperForm")?.addEventListener("submit", submitHelper);
    document.querySelectorAll(".helper-remove").forEach(btn => btn.addEventListener("click", () => removeOpsHelper(btn.dataset.id)));
    document.getElementById("timeoutForm")?.addEventListener("submit", submitTimeout);
    document.getElementById("blockForm")?.addEventListener("submit", submitBlock);
    document.getElementById("crashoutSettingsForm")?.addEventListener("submit", submitCrashoutSettings);
    document.querySelectorAll(".copy-command").forEach(btn => btn.addEventListener("click", () => copyCommand(btn.dataset.command, btn)));
    document.querySelectorAll(".unblock-account").forEach(btn => btn.addEventListener("click", () => unblockAccount(btn.dataset.email)));




}

function openTrackerAddModal() {
    showModal(`<div class="modal"><div class="modal-header"><div><span class="modal-eyebrow">Tracker</span><h2>Add activity</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><form id="trackerForm" class="ops-form"><label>Staff member<input name="staff_name" list="trackerStaffNames" placeholder="Type staff name or Discord ID" required><datalist id="trackerStaffNames">${staff.map(s=>`<option value="${escapeAttribute(s.name||'')}"></option><option value="${escapeAttribute(s.discord_id||'')}"></option>`).join("")}</datalist></label><input type="hidden" name="staff_id"><input name="team" maxlength="80" placeholder="Team" required><input name="activity_type" maxlength="80" placeholder="Activity type" required><select name="status"><option>Logged</option><option>Pending</option><option>Completed</option></select><textarea name="notes" rows="4" placeholder="Notes"></textarea><button class="primary-button">Save activity</button></form></div>`);
    document.getElementById("trackerForm")?.addEventListener("submit", submitTracker);
}

async function submitTracker(e) {
    e.preventDefault(); if(!canManage()) return;
    const f = e.target; const payload = Object.fromEntries(new FormData(f).entries());
    const typedStaff=String(payload.staff_name||'').trim();
    const matchedStaff=(staff||[]).find(x=>String(x.name||'').toLowerCase()===typedStaff.toLowerCase() || String(x.discord_id||'')===typedStaff);
    if(!matchedStaff) return alert('Choose a valid staff name or enter their exact Discord ID.');
    payload.staff_id=matchedStaff.id; delete payload.staff_name; payload.created_by=currentUser.id;
    const { error } = await supabaseClient.from("ops_tracker").insert(payload);
    if(error) return alert(error.message); await writeAudit("tracker.created", payload); closeModal(); await loadOpsData(); render();
}

async function submitPoints(e) {
    e.preventDefault(); if(!canManage()) return; const f=e.target; const payload=Object.fromEntries(new FormData(f).entries()); payload.team=String(payload.team||'').toLowerCase(); if(!['actions','interactions'].includes(payload.team)) return alert('Choose Actions or Interactions for this points adjustment.'); payload.amount=Math.max(-25,Math.min(25,Number(payload.amount))); payload.created_by=currentUser.id;
    const { error }=await supabaseClient.from("ops_points").insert(payload); if(error) return alert(error.message); await writeAudit("points.adjusted", payload); await loadOpsData(); render();
}






async function submitReduction(e) {
    e.preventDefault(); if(!canManage()) return; const payload=Object.fromEntries(new FormData(e.target).entries()); payload.amount=Math.max(1,Number(payload.amount)); payload.created_by=currentUser.id; payload.active=true;
    const {error}=await supabaseClient.from("ops_reductions").insert(payload); if(error) return alert(error.message); await writeAudit("reduction.created",payload); await loadOpsData(); render();
}

async function submitPrize(e) {
    e.preventDefault(); if(!canManage()) return; const payload=Object.fromEntries(new FormData(e.target).entries()); payload.amount=Math.max(1,Number(payload.amount)); payload.created_by=currentUser.id; payload.active=true;
    const {error}=await supabaseClient.from("ops_prizes").insert(payload); if(error) return alert(error.message); await writeAudit("prize.created",payload); await loadOpsData(); render();
}

async function submitHelper(e) {
    e.preventDefault();
    if (!canManage()) return;
    const form = e.target;
    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
        event_id: String(data.event_id || "").trim(),
        staff_id: String(data.staff_id || "").trim(),
        note: String(data.note || "").trim() || null,
        created_by: currentUser.id
    };
    if (!payload.event_id || !payload.staff_id) return alert("Choose both an event and a staff member.");
    const { error } = await supabaseClient.from("ops_helpers").insert(payload);
    if (error) {
        if (String(error.code || "") === "23505") return alert("That staff member is already assigned as a helper for this event.");
        return alert(error.message);
    }
    await writeAudit("helper.assigned", payload);
    await loadOpsData();
    render();
}

async function submitTimeout(e) {
    e.preventDefault();
    if (!canManage()) return;
    const f = e.target;
    const emails = String(new FormData(f).get("emails") || "").split(/\s*[\n,;]\s*/).map(x=>x.trim().toLowerCase()).filter(Boolean);
    const minutes = Math.max(1, Math.min(10080, Number(new FormData(f).get("minutes")) || 30));
    const reason = String(new FormData(f).get("reason") || "").trim();
    const expires_at = new Date(Date.now() + minutes * 60000).toISOString();
    if (!emails.length) return;
    const rows = emails.map(email => ({ email, expires_at, reason, created_by: currentUser.id }));
    const { error } = await supabaseClient.from("ops_timeouts").insert(rows);
    if (error) return alert(error.message);
    await supabaseClient.from("ops_security").insert(emails.map(email => ({ actor_id: currentUser.id, actor_name: currentUser.email || "Staff", event_type: "timeout.created", severity: "warning", details: { email, minutes, reason, expires_at } })));
    await writeAudit("security.timeout", { emails, minutes, reason });
    await loadOpsData(); render();
}

async function submitCrashoutSettings(e) {
    e.preventDefault();
    if (!isDirector()) return;
    const data = Object.fromEntries(new FormData(e.target).entries());
    const payload = { id: 1, max_removals: Math.max(1, Math.min(50, Number(data.max_removals)||3)), window_minutes: Math.max(1, Math.min(1440, Number(data.window_minutes)||60)), timeout_minutes: Math.max(1, Math.min(10080, Number(data.timeout_minutes)||30)), updated_by: currentUser.id };
    const { error } = await supabaseClient.from('ops_security_settings').upsert(payload, { onConflict: 'id' });
    if (error) return alert(error.message);
    crashoutSettings = payload;
    await loadOpsData(); render();
}

async function submitBlock(e) {
    e.preventDefault();
    if (!canManage()) return;
    const cooldown = enforceCooldown("kick-off", 30);
    if (cooldown) return alert(`Kick-off is on a 30-second cooldown. Try again in ${cooldown}s.`);
    const data = new FormData(e.target);
    const emails = String(data.get("emails") || "").split(/\s*[\n,;]\s*/).map(x=>x.trim().toLowerCase()).filter(Boolean);
    const reason = String(data.get("reason") || "Inactivity").trim() || "Inactivity";
    if (!emails.length) return;
    const windowStart = new Date(Date.now() - Number(crashoutSettings.window_minutes || 60) * 60000).toISOString();
    const { count } = await supabaseClient.from('ops_security').select('id', { count: 'exact', head: true }).eq('actor_id', currentUser.id).eq('event_type', 'team.removed').gte('created_at', windowStart);
    const currentCount = Number(count || 0);
    const limit = Number(crashoutSettings.max_removals || 3);
    if (currentCount + emails.length > limit) {
        const actorEmail = String(currentUser.email || '').toLowerCase();
        if (actorEmail) {
            const expires_at = new Date(Date.now() + Number(crashoutSettings.timeout_minutes || 30) * 60000).toISOString();
            await supabaseClient.from('ops_timeouts').insert({ email: actorEmail, expires_at, reason: `Crashout protection: ${currentCount + emails.length} removals attempted within ${crashoutSettings.window_minutes} minutes`, created_by: currentUser.id });
            await supabaseClient.from('ops_security').insert({ actor_id: currentUser.id, actor_name: currentUser.email || 'Staff', event_type: 'crashout.timeout', severity: 'critical', details: { attempted: emails.length, previous: currentCount, limit, window_minutes: crashoutSettings.window_minutes, timeout_minutes: crashoutSettings.timeout_minutes } });
            await writeAudit('security.crashout_timeout', { attempted: emails.length, previous: currentCount, limit });
            await loadAccess(); await loadOpsData(); render();
            return alert(`Crashout protection triggered. You reached the limit of ${limit} removals in ${crashoutSettings.window_minutes} minutes. You have been timed out for ${crashoutSettings.timeout_minutes} minutes.`);
        }
        return alert(`Crashout protection blocked this action. Limit: ${limit} removals in ${crashoutSettings.window_minutes} minutes.`);
    }
    const rows = emails.map(email => ({ email, reason, active: true, created_by: currentUser.id }));
    const { error } = await supabaseClient.from("ops_access_blocks").upsert(rows, { onConflict: "email" });
    if (error) return alert(error.message);
    await supabaseClient.from("ops_security").insert(emails.map(email => ({ actor_id: currentUser.id, actor_name: currentUser.email || "Staff", event_type: "team.removed", severity: "critical", details: { email, reason } })));
    await writeAudit("team.removed", { emails, reason });
    await loadOpsData(); render();
}

async function unblockAccount(email) {
    if (!isAdmin()) return alert("Admin access required to unblock accounts.");
    const { error } = await supabaseClient.from("ops_access_blocks").update({ active:false }).eq("email", email);
    if (error) return alert(error.message);
    await writeAudit("team.reinstated", { email });
    await loadOpsData(); render();
}

function bindPrizePageHandlers(){
    const form=document.getElementById("prizeWinPageForm");
    if(!form)return;
    const update=()=>{
        const prize=(ops.prizes||[]).find(p=>p.id===form.prize_id.value&&p.active!==false);
        const amount=document.getElementById("prizeWinAmount");
        const box=document.getElementById("prizeWinPageCommand");
        const copy=document.getElementById("copyPrizePageCommand");
        if(amount)amount.value=prize?Number(prize.amount||0):"";
        const command=prize&&form.discord_id.value.trim()&&form.reason.value.trim()
            ? buildPrizeCommand(prize,form.discord_id.value.trim(),form.reason.value.trim())
            : "Enter the ID, choose a type and enter a reason.";
        if(box)box.textContent=command;
        if(copy){copy.disabled=command.startsWith("Enter the ID");copy.dataset.command=command;}
    };
    form.addEventListener("input",update);
    form.addEventListener("change",update);
    document.getElementById("copyPrizePageCommand")?.addEventListener("click",function(){copyCommand(this.dataset.command,this);});
    form.addEventListener("submit",submitPrizeWinPage);
    document.querySelectorAll(".prize-done-toggle").forEach(cb=>cb.addEventListener("change",()=>markPrizeDone(cb.dataset.id,cb.checked)));
    update();
}
async function submitPrizeWinPage(e){
    e.preventDefault();
    if(!canManage())return;
    const form=e.target,data=new FormData(form);
    const discord_id=String(data.get("discord_id")||"").trim();
    const reason=String(data.get("reason")||"").trim();
    const prize_id=String(data.get("prize_id")||"");
    const prize=(ops.prizes||[]).find(p=>String(p.id)===prize_id&&p.active!==false);
    const err=document.getElementById("prizeWinPageError");
    if(err)err.textContent="";
    if(!discord_id||!prize||!reason){
        if(err)err.textContent="Enter an in-game ID, choose a prize and enter a reason.";
        return;
    }
    const command=buildPrizeCommand(prize,discord_id,reason);
    const payload={
        prize_id,
        recipient_name:discord_id,
        discord_id,
        amount:Number(prize.amount||0),
        reason,
        command,
        won_by:currentUser.id,
        completed:false
    };
    const {error}=await supabaseClient.from("ops_prize_wins").insert(payload);
    if(error){if(err)err.textContent=error.message;return;}
    await writeAudit("prize.won",payload);
    await loadOpsData();
    render();
}
async function markPrizeDone(id,done){if(!canManage())return;const payload={completed:done,completed_at:done?new Date().toISOString():null,completed_by:done?currentUser.id:null},{error}=await supabaseClient.from("ops_prize_wins").update(payload).eq("id",id);if(error)return alert(error.message);await writeAudit(done?"prize.completed":"prize.reopened",{id});await loadOpsData();render();}
async function copyCommand(command, button) {
    try { await navigator.clipboard.writeText(command); button.textContent = "Copied"; setTimeout(()=>button.textContent="Copy",1200); }
    catch (_) { alert(command); }
}

async function writeAudit() {
    // Audit logging is disabled: no audit log is displayed or written by the website.
    return;
}

function buildRecurringDates(startDate, repeat, untilDate) {
    const dates = [startDate];
    if (repeat === "none") return dates;
    const current = new Date(`${startDate}T12:00:00`);
    const until = new Date(`${untilDate}T12:00:00`);
    const step = repeat === "weekly" ? 7 : repeat === "biweekly" ? 14 : 0;
    let guard = 0;
    while (guard++ < 52) {
        if (repeat === "monthly") current.setMonth(current.getMonth() + 1);
        else current.setDate(current.getDate() + step);
        if (current > until) break;
        dates.push(formatDate(current));
    }
    return dates;
}

function isEventCompleted(event) {
    return event.status === "completed";
}

function applyEventPreset(preset) {
    const title = document.getElementById("eventTitle");
    if (!title) return;
    title.value = preset;
    const type = eventTypes.find(t => String(t.name || "").toLowerCase() === preset.toLowerCase());
    if (type) document.getElementById("eventType").value = type.id;
    if (preset === "Community Meeting") {
        document.getElementById("eventVisibility").value = "staff";
        document.getElementById("eventRepeat").value = "biweekly";
    }
}

function renderAccessRestriction() {
    const timeout = currentTimeout;
    const blocked = accessBlock;
    app.innerHTML = `<div class="schedule-app"><main class="restricted-screen"><div class="restricted-card"><div class="schedule-logo crown-logo"><img src="kngcroiwn.png" alt="KNG crown"></div><h1>${blocked ? "Access Removed" : "Temporarily Timed Out"}</h1><p>${blocked ? `Your KNG Entertainment access has been removed from the team.` : `Your access is temporarily unavailable until ${formatOpsDateTime(timeout?.expires_at)}.`}</p><small>${escapeHtml((blocked?.reason || timeout?.reason || "Contact management."))}</small><button class="header-button" onclick="logout()">Sign Out</button></div></main></div>`;
}

function formatOpsDateTime(value) {
    if(!value) return "";
    const d=new Date(value); if(Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-GB", {day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"});
}

window.switchOpsView = switchOpsView;
window.loginWithDiscord = loginWithDiscord;
window.requestStaffAccess = requestStaffAccess;
window.approveAccessRequest = approveAccessRequest;
window.rejectAccessRequest = rejectAccessRequest;
window.openPrizeWinModal = () => switchOpsView("prizes");
window.copyCommand = copyCommand;
window.submitCrashoutSettings = submitCrashoutSettings;



/* =========================================================
   KNG INTERACTIONS INTEGRATION
   Recreates the useful Interactions screens shown in the source
   website while keeping this app's Supabase/auth architecture.
   ========================================================= */

async function loadInteractionData() {
    const [hof, suggestions, eventSubmissions] = await Promise.all([
        loadOpsTable("ix_hall_of_fame", () => supabaseClient.from("ix_hall_of_fame").select("*").order("created_at", {ascending:false}).limit(100)),
        loadOpsTable("event_suggestions", () => supabaseClient.from("event_suggestions").select("*").order("created_at", {ascending:false}).limit(200)),
        loadOpsTable("kng_event_submissions", () => supabaseClient.from("kng_event_submissions").select("*").order("created_at", {ascending:false}).limit(200))
    ]);
    let goals = [];
    if (currentUser) {
        goals = await loadOpsTable("ix_daily_goals", () => supabaseClient.from("ix_daily_goals").select("*").eq("user_id", currentUser.id).order("goal_date", {ascending:false}).limit(30));
    }
    ixData = { hof, goals, suggestions, eventSubmissions };
}

function interactionHeader(title, subtitle) {
    return opsHeader(title, subtitle);
}

function renderPublicF3Calendar() {
    const today = formatDate(new Date());
    const now = new Date();
    const publicEvents = (allEvents || [])
        .filter(e => e.event_date === today && !e.is_meeting && e.status !== 'cancelled' && (e.visibility || 'public') !== 'staff')
        .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));

    let nextFound = false;
    const cards = publicEvents.map(e => {
        const start = new Date(`${e.event_date}T${String(e.start_time || '00:00:00').slice(0,8)}`);
        const end = new Date(`${e.event_date}T${String(e.end_time || e.start_time || '00:00:00').slice(0,8)}`);
        const passed = end.getTime() <= now.getTime();
        const upcoming = !passed && !nextFound;
        if (upcoming) nextFound = true;
        const type = e.event_types?.name || 'Event';
        const host = e.host_claimed_name ? ` · Hosted by ${e.host_claimed_name}` : '';
        return `
            <article class="public-f3-event ${passed ? 'is-passed' : ''} ${upcoming ? 'is-next' : ''}">
                <div class="public-f3-time"><strong>${formatTime(e.start_time)}</strong><span>${formatTime(e.end_time)}</span></div>
                <div class="public-f3-event-main">
                    <div class="public-f3-event-title-row"><h3>${escapeHtml(e.title)}</h3>${upcoming ? `<span class="public-f3-next-badge">NEXT</span>` : ''}</div>
                    <span class="public-f3-type">${escapeHtml(type)}</span>${e.location ? `<span class="public-f3-location">📍 ${escapeHtml(e.location)}</span>` : ''}${host ? `<span class="public-f3-host">${escapeHtml(host)}</span>` : ''}
                </div>
            </article>`;
    }).join('');

    return `<div class="public-f3-wrap">
        <section class="public-f3-hero"><div><span class="public-f3-eyebrow">F3 EVENT CALENDAR</span><h2>${new Date(`${today}T00:00:00`).toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'})}</h2><p>Public entertainment events only. Staff meetings and private events are never shown here.</p></div><div class="public-f3-count"><strong>${publicEvents.length}</strong><span>events today</span></div></section>
        <section class="public-f3-list">${cards || `<div class="ix-empty public-f3-empty"><strong>No public F3 events are scheduled today.</strong><small>Once a public event is added or randomised in Host an Event, it will appear here automatically.</small></div>`}</section>
    </div>`;
}

function renderInteractionView() {
    const publicViews = ["event-suggestions", "public-f3"];
    const staffOnlyViews = ["command-dashboard", "personal-dashboard", "staff-roster", "current-host", "actions-dashboard"];
    const team = isTeamSpecificView(ixView);
    if (team && !canUseTeam(team)) {
        ixView = "personal-dashboard";
        try { localStorage.setItem("kng.ixView", "personal-dashboard"); } catch (_) {}
    }
    if (staffOnlyViews.includes(ixView) && permissionRank() < 1) {
        ixView = "event-suggestions";
        try { localStorage.setItem("kng.ixView", "event-suggestions"); } catch (_) {}
    }
    if (!currentUser && !publicViews.includes(ixView)) { showLoginMessage(); return; }
    const titles = {
        "command-dashboard":["Command Dashboard","Shared KNG command centre"],
        "interactions-leaderboard":["Leaderboard","Interactions hosting and staff activity"],
        "hall-of-fame":["Hall of Fame","Winner frames and event recognition"],
        "personal-dashboard":["Personal Dashboard",`${String(getCurrentEntertainmentTeam() || "KNG").toUpperCase()} staff workspace`],
        "public-f3":["Public F3 Events","Today’s public entertainment schedule"],
        "staff-roster":["Staff Roster","Current KNG Entertainment staff"],
        "event-suggestions":["Event Ideas Forum","Community ideas for future KNG events"],
        "current-host":["Current Host","Live and upcoming Interactions hosting"],
        "actions-dashboard":["Actions Dashboard","Your Actions assignments, activity and upcoming work"]
    };
    const [title,subtitle]=titles[ixView] || titles["command-dashboard"];
    app.innerHTML=`<div class="schedule-app operations-app ix-integration-app">${interactionHeader(title,subtitle)}<div class="app-body operations-body">${operationsNavHtml()}<main class="operations-main"><div class="operations-content">${renderIxViewHtml()}</div></main></div><div id="modalContainer"></div></div>`;
    bindInteractionHandlers();
}

function renderIxViewHtml(){
    switch(ixView){
        case "command-dashboard": return renderInteractionDashboard();
        case "interactions-leaderboard": return renderInteractionLeaderboard();
        case "hall-of-fame": return renderHallOfFame();
        case "personal-dashboard": return renderPersonalDashboard();
        case "staff-roster": return renderStaffRoster();
        case "event-suggestions": return renderEventSuggestions();
        case "public-f3": return renderPublicF3Calendar();
        case "current-host": return renderCurrentHost();
        case "actions-dashboard": return renderActionsDashboard();
        default: return renderInteractionDashboard();
    }
}

function renderInteractionDashboard(){
    const upcomingEvents=getUpcomingDashboardEvents(8);
    const completed=allEvents.filter(e=>!e.is_meeting && isEventCompleted(e));
    const popular=[...completed].filter(e=>Number.isFinite(Number(e.attendance_count))).sort((a,b)=>Number(b.attendance_count||0)-Number(a.attendance_count||0)).slice(0,5);
    const scheduleHtml=upcomingEvents.length
        ? `<div class="ix-schedule-list">${upcomingEvents.map(e=>`<div><span>${escapeHtml(dashboardEventDateLabel(e))}</span><b>${escapeHtml(e.title)}</b><small>${formatTime(e.start_time)} · ${escapeHtml(e.event_types?.name||"Event")}</small></div>`).join("")}</div>`
        : `<div class="ix-empty">No upcoming events are scheduled. The calendar is, for once, allowed to breathe.</div>`;
    const popularHtml=popular.length
        ? `<div class="ix-table popular-events-table">${popular.map((e,i)=>`<div class="ix-table-row"><span class="ix-rank">#${i+1}</span><div class="ix-grow"><b>${escapeHtml(e.title)}</b><small>${escapeHtml(e.event_date)} · ${escapeHtml(e.event_types?.name||'Event')}</small></div><span><b>${Number(e.attendance_count||0)}</b><small>attended</small></span></div>`).join('')}</div>`
        : `<div class="ix-empty">No completed attendance records yet.</div>`;
    return `<div class="ix-command-grid">
      <div class="ix-stat-row">
        <div class="ix-stat"><span>Events Today</span><strong>${(allEvents||[]).filter(e=>e.event_date===formatDate(new Date()) && !e.is_meeting).length}</strong><small>scheduled entertainment events</small></div>
        <div class="ix-stat"><span>Completed Events</span><strong>${completed.length}</strong><small>manually confirmed</small></div>
        <div class="ix-stat"><span>Event Ideas</span><strong>${(ixData.suggestions||[]).length}</strong><small>community suggestions</small></div>
        <div class="ix-stat"><span>Top Attendance</span><strong>${popular[0]?.attendance_count || 0}</strong><small>${popular[0] ? escapeHtml(popular[0].title) : 'No completed events yet'}</small></div>
      </div>
      <div class="ix-two-col">
        ${ixPanel("Next Events",scheduleHtml,`<span class="ix-panel-note">Rolling from the current time</span>`)}
        ${ixPanel("Most Popular Events",popularHtml,`<span class="ix-panel-note">Highest recorded attendance</span>`)}
      </div>
      <div class="ix-panel">
        <div class="ix-panel-head"><div><h3>Quick Actions</h3><small>Staff shortcuts for your workspace</small></div></div>
        <div class="ix-quick-grid">
            ${isInteractionsStaff() ? `<button onclick="switchOpsView('current-host')">Current Host</button><button onclick="switchOpsView('host-event')">Host an Event</button><button onclick="switchOpsView('hall-of-fame')">Hall of Fame</button>` : `<button onclick="switchOpsView('actions-dashboard')">Actions Dashboard</button><button onclick="switchOpsView('staff-roster')">Staff Roster</button>`}
            <button onclick="switchOpsView('event-suggestions')">Event Suggestions</button>
            ${currentUser?`<button onclick="switchOpsView('personal-dashboard')">Personal Dashboard</button>`:''}
        </div>
      </div>
    </div>`;
}

function ixPanel(title,body,action=""){ return `<section class="ix-panel"><div class="ix-panel-head"><div><h3>${escapeHtml(title)}</h3></div>${action}</div>${body}</section>`; }

function renderInteractionLeaderboard(){
    const hosted=new Map();
    const names=new Map();
    for(const e of (allEvents||[])){
        const id=String(e.host_claimed_by||'').trim();
        if(!id) continue;
        const key=id;
        hosted.set(key,(hosted.get(key)||0)+1);

        // Leaderboards must use the KNG roster display name, never the
        // Discord username captured when the event slot was claimed.
        const discordId=String(e.host_claimed_discord||'').trim();
        const rosterMember=(rosterData||[]).find(r =>
            String(r.staff?.discord_id||r.discord_id||'').trim()===discordId ||
            String(r.staff_id||r.staff?.id||'')===String(e.host_claimed_staff_id||'')
        );
        const staffMember=(staff||[]).find(s =>
            (discordId && String(s.discord_id||'').trim()===discordId) ||
            String(s.id||'')===String(e.host_claimed_staff_id||'')
        );
        const rosterName=String(rosterMember?.display_name||rosterMember?.staff?.name||staffMember?.name||'').trim();
        names.set(key, rosterName || 'Not on roster');
    }
    const hostedRows=[...hosted.entries()].sort((a,b)=>b[1]-a[1]).map(([id,total])=>({id,total,name:names.get(id)||'Not on roster'}));
    const pointMap=new Map();
    for(const p of (ops.points||[]).filter(x=>String(x.team||'interactions').toLowerCase()==='interactions')){
        const id=String(p.staff_id||p.user_id||'').trim();
        if(!id) continue;
        pointMap.set(id,(pointMap.get(id)||0)+Number(p.amount||0));
    }
    const pointRows=[...pointMap.entries()].sort((a,b)=>b[1]-a[1]).map(([id,total])=>({id,total,name:staff.find(s=>String(s.id)===id)?.name||'Staff'}));
    const activityMap=new Map();
    for(const x of (ops.tracker||[])){
        const id=String(x.staff_id||'').trim();
        if(!id) continue;
        activityMap.set(id,(activityMap.get(id)||0)+1);
    }
    const activityRows=[...activityMap.entries()].sort((a,b)=>b[1]-a[1]).map(([id,total])=>({id,total,name:staff.find(s=>String(s.id)===id)?.name||'Staff'}));
    const rows=(list,label,unit)=>list.length?`<div class="ix-table">${list.slice(0,10).map((r,i)=>`<div class="ix-table-row"><span class="ix-rank">#${i+1}</span><div class="ix-grow"><b>${escapeHtml(r.name)}</b></div><span><b>${r.total}</b><small>${unit}</small></span></div>`).join('')}</div>`:`<div class="ix-empty">No ${escapeHtml(label.toLowerCase())} recorded yet.</div>`;
    return `<div class="ix-leaderboard-page"><div class="ix-two-col leaderboard-sections"><div class="ix-panel"><div class="ix-panel-head"><div><h3>Most Events Hosted</h3><small>Staff with the most claimed event slots</small></div></div>${rows(hostedRows,'hosted events','events hosted')}</div><div class="ix-panel"><div class="ix-panel-head"><div><h3>Most Points</h3><small>Highest staff point totals</small></div></div>${rows(pointRows,'points','points')}</div><div class="ix-panel"><div class="ix-panel-head"><div><h3>Most Activity</h3><small>Logged KNG activity</small></div></div>${rows(activityRows,'activity','activities')}</div></div><section class="ix-panel ix-team-points-leaderboard"><div class="ix-panel-head"><div><h3>Interactions Team Points Leaderboard</h3><small>Individual points awarded to Interactions staff, highest total first</small></div><span class="ix-pill">Interactions</span></div>${renderTeamPointsLeaderboard('interactions')}</section></div>`;
}

function renderAnnouncements(){ return ''; }

// Community suggestion moderation: normalize text so simple obfuscation like
// "f u c k" or "s.l.u.r" is still caught before it reaches the public forum.
const BLOCKED_SUGGESTION_TERMS = [
    'fuck','fucker','fucking','shit','shite','bitch','bastard','cunt','twat','prick','dickhead',
    'nigger','nigga','faggot','fag','dyke','tranny','retard','spastic','kike','chink','paki','coon',
    'wetback','gook','kike','raghead','beaner','cripple','mong','retardation','whore','slut','skank',
    'rape','rapist','molest','pedo','paedo','nonce','nazi'
];
function normalizeSuggestionModerationText(value='') {
    return String(value||'').toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,'');
}
function containsBlockedSuggestionLanguage(...values) {
    const raw = values.map(v=>String(v||'').toLowerCase()).join(' ');
    const normalized = normalizeSuggestionModerationText(raw);
    return BLOCKED_SUGGESTION_TERMS.some(term => {
        const t = normalizeSuggestionModerationText(term);
        return normalized.includes(t) || new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}(?=$|[^a-z0-9])`,'i').test(raw);
    });
}

function renderEventSuggestions(){
    const suggestions=ixData.suggestions || [];
    const suggestionError = opsLoadErrors.event_suggestions;
    const submitBtn = `<button class="primary-button" onclick="openNewEventSuggestionModal()">+ Post an Idea</button>`;
    const suggestionCards=suggestions.map(s=>{
        const status=String(s.status||'new').toLowerCase();
        const statusLabel={new:'NEW',reviewed:'REVIEWED',accepted:'ACCEPTED',declined:'DECLINED'}[status] || status.toUpperCase();
        const moderation=canApproveEvents() ? `<div class="suggestion-actions">${['new','reviewed'].includes(status) ? `<button class="secondary-button" onclick="setSuggestionStatus('${s.id}','reviewed')">Mark reviewed</button><button class="secondary-button" onclick="setSuggestionStatus('${s.id}','accepted')">Accept idea</button><button class="secondary-button" onclick="setSuggestionStatus('${s.id}','declined')">Decline</button>` : ''}<button class="secondary-button danger-button" onclick="deleteSuggestion('${s.id}')">Delete</button></div>` : '';
        return `<article class="suggestion-card forum-suggestion-card status-${escapeAttribute(status)}"><div><span class="ix-label">${escapeHtml(statusLabel)}</span><small>${formatOpsDateTime(s.created_at)}</small></div><h4>${escapeHtml(s.title||'Event idea')}</h4><p>${escapeHtml(s.suggestion||'')}</p><small>Idea by ${escapeHtml(s.display_name||'Anonymous')}</small>${moderation}</article>`;
    }).join('');
    return `<div class="event-suggestions-page">${suggestionError ? `<div class="ix-panel schema-error-panel"><strong>Event Ideas is not connected to Supabase yet.</strong><small>${escapeHtml(suggestionError)}</small><small>Run <b>KNG-EVENT-IDEAS-FORUM-PATCH.sql</b> from the downloaded package once.</small></div>` : ''}<section class="ix-panel event-suggestions-forum event-ideas-hero"><div class="ix-panel-head"><div><span class="public-f3-eyebrow">KNG COMMUNITY</span><h2>Event Ideas Forum</h2><small>Have an idea for an event? Post it here. Staff can review the suggestions, choose the good ones and turn them into real KNG events.</small></div>${submitBtn}</div><div class="forum-note"><strong>This is an ideas board, not an event booking form.</strong><span>Posting an idea does not schedule anything or reserve a time slot. It simply puts the idea in front of the KNG team.</span></div></section><section class="ix-panel event-suggestions-forum"><div class="ix-panel-head"><div><h3>Community Ideas</h3><small>${suggestions.length} idea${suggestions.length===1?'':'s'} posted · newest first</small></div></div><div class="suggestion-list">${suggestionCards || `<div class="ix-empty"><strong>No ideas have been posted yet.</strong><small>Be the first human to inflict a new event concept upon the KNG team.</small></div>`}</div></section></div>`;
}

function renderHallOfFame(){
    const current=ixData.hof[0] || {};
    const frames=[
        {name:'Original', key:'original', src:'kng-hof-original.png'},
        {name:'Gold', key:'gold', src:'kng-hof-gold.png'},
        {name:'Emerald', key:'emerald', src:'kng-hof-emerald.png'},
        {name:'Ocean', key:'ocean', src:'kng-hof-ocean.png'},
        {name:'Sunset', key:'sunset', src:'kng-hof-sunset.png'},
        {name:'Pink', key:'pink', src:'kng-hof-pink.png'},
        {name:'Grey Scale', key:'grey-scale', src:'kng-hof-grey-scale.png'},
        {name:'Colour Wheel', key:'colour-wheel', src:'kng-hof-grey-scale.png'},
        {name:'Fire', key:'fire', src:'kng-hof-grey-scale.png'},
        {name:'Rainbow', key:'rainbow', src:'kng-hof-grey-scale.png'},
        {name:'Custom', key:'custom', src:'kng-hof-grey-scale.png'}
    ];
    const selected=String(current.frame||'Original').toLowerCase().replace(/\s+/g,'-') || 'original';
    const colour=current.frame_colour || '#ff19b7';
    const safeUrl=escapeHtml(current.image_url||'');
    return `${ixSchemaNotice("ix_hall_of_fame")}<div class="ix-hof-layout ix-hof-layout-v2">
      <div class="ix-hof-canvas ix-hof-stage">
        <div class="hof-composer" id="hofComposer" data-frame="${escapeHtml(selected)}" style="--hof-custom:${escapeHtml(colour)};--hof-intensity:${Math.max(0,Math.min(100,Number(current.intensity)||100))/100}">
          <img id="hofFrameImage" class="hof-frame-image" src="${hofFrameAsset(selected)}" alt="KNG Estate Roleplay Hall of Fame frame">
          <div class="hof-photo-window" id="hofPhotoWindow">
            ${safeUrl?`<img id="hofWinnerPhoto" class="hof-winner-photo" src="${safeUrl}" alt="Winner" style="--hof-scale:${Number(current.photo_scale)||1};--hof-x:${Number(current.photo_x)||0}px;--hof-y:${Number(current.photo_y)||0}px">`:`<span class="hof-photo-placeholder">Add winner photo</span>`}
          </div>
        </div>
      </div>
      <div class="ix-hof-controls">
        <div class="ix-panel hof-control-panel">
          <div class="ix-panel-head"><div><h3>Hall of Fame</h3><small>Build the winner card exactly like the KNG frame.</small></div></div>
          <div class="hof-control-section"><b>Frame Library</b><div class="ix-frame-grid hof-frame-grid">${frames.map(f=>`<button class="ix-frame-chip hof-frame-chip ${selected===f.key?'active':''}" data-hof-frame="${f.key}" onclick="selectHofFrame('${f.key}')">${escapeHtml(f.name)}</button>`).join('')}</div></div>
          <label>Winner name<input id="hofWinnerName" list="hofStaffNames" value="${escapeHtml(current.winner_name||'')}" placeholder="Type winner name"><datalist id="hofStaffNames">${(staff||[]).map(x=>`<option value="${escapeAttribute(x.name||'')}"></option>`).join('')}</datalist></label><label>Winner Discord ID<input id="hofWinnerDiscordId" value="${escapeAttribute(current.winner_discord_id||'')}" placeholder="Enter Discord ID instead (optional)"></label>
          <div class="hof-photo-actions">${canManage()?`<button class="header-button" onclick="openHofUpload()">Add winner photo</button><button class="header-button danger-button" onclick="removeHofPhoto()">Remove photo</button>`:''}<button class="header-button" onclick="resetHofPhoto()">Reset photo position</button></div>
          <div class="hof-colour-panel" id="hofCustomControls">
            <div class="hof-colour-top"><div class="hof-colour-swatch" id="hofColourSwatch" style="background:${escapeAttribute(colour)}" onclick="document.getElementById('hofColour')?.click()"></div><input id="hofHex" class="hof-hex-input" value="${escapeAttribute(colour.toUpperCase())}" maxlength="7" aria-label="Hex colour" oninput="applyHofHex(this.value)"><span id="hofRgb" class="hof-rgb">${escapeHtml(hofRgbLabel(colour))}</span></div>
            <label class="hof-range-label"><span>Hue</span><input id="hofHue" type="range" min="0" max="359" value="${hofHueFromHex(colour)}" oninput="applyHofHue(this.value)"><small id="hofHueValue">${hofHueFromHex(colour)}°</small></label>
            <label class="hof-range-label"><span>Intensity</span><input id="hofIntensity" type="range" min="0" max="100" value="${Math.round((Number(current.intensity)||100))}" oninput="applyHofCustomIntensity(this.value)"><small id="hofIntensityValue">${Math.round((Number(current.intensity)||100))}%</small></label>
            <button type="button" class="secondary-button" onclick="resetHofColour()">Reset colour</button>
            <input id="hofColour" type="color" value="${escapeAttribute(colour)}" oninput="applyHofCustomColour(this.value)" style="position:absolute;left:-9999px;opacity:0;pointer-events:none">
          </div>
          <div class="hof-help">Drag the winner photo inside the black box. Scroll to zoom.</div>
          <div class="hof-action-row">${canManage()?`<button class="primary-button" onclick="saveHallOfFame()">Save Winner</button>`:""}<button class="header-button" onclick="downloadHallOfFame()">Download</button></div>
        </div>
      </div>
    </div>`;
}

function hofFrameAsset(key){
    if(key==='original') return 'kng-hof-original.png';
    if(['gold','emerald','ocean','sunset','pink','grey-scale','colour-wheel','fire','rainbow','custom'].includes(key)) return `kng-hof-${key}.png`;
    return 'kng-hof-grey-scale.png';
}
function hofRgbLabel(hex){
    const value=String(hex||'').replace('#','');
    if(!/^[0-9a-fA-F]{6}$/.test(value)) return 'rgb(255, 25, 183)';
    return `rgb(${parseInt(value.slice(0,2),16)}, ${parseInt(value.slice(2,4),16)}, ${parseInt(value.slice(4,6),16)})`;
}
function hofHueFromHex(hex){
    const value=String(hex||'').replace('#','');
    if(!/^[0-9a-fA-F]{6}$/.test(value)) return 330;
    const r=parseInt(value.slice(0,2),16)/255,g=parseInt(value.slice(2,4),16)/255,b=parseInt(value.slice(4,6),16)/255;
    const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min; let h=0;
    if(d){ if(max===r) h=((g-b)/d)%6; else if(max===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0)h+=360; }
    return Math.round(h);
}
function hofHslToHex(h,s=90,l=55){
    s/=100;l/=100;const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2;let r=0,g=0,b=0;
    if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}
    return '#'+[r,g,b].map(v=>Math.round((v+m)*255).toString(16).padStart(2,'0')).join('').toUpperCase();
}
function updateHofColourMeta(value){
    const hex=String(value||'#FF19B7').toUpperCase();
    const swatch=document.getElementById('hofColourSwatch'); if(swatch) swatch.style.background=hex;
    const hexEl=document.getElementById('hofHex'); if(hexEl && /^#[0-9A-F]{6}$/.test(hex)) hexEl.value=hex;
    const rgb=document.getElementById('hofRgb'); if(rgb) rgb.textContent=hofRgbLabel(hex);
    const hue=hofHueFromHex(hex); const hueEl=document.getElementById('hofHue'); if(hueEl) hueEl.value=String(hue);
    const hueValue=document.getElementById('hofHueValue'); if(hueValue) hueValue.textContent=`${hue}°`;
}
function applyHofHue(value){
    const hue=Math.max(0,Math.min(359,Number(value)||0));
    const hex=hofHslToHex(hue); const input=document.getElementById('hofColour'); if(input) input.value=hex;
    applyHofCustomColour(hex); const hueValue=document.getElementById('hofHueValue'); if(hueValue) hueValue.textContent=`${hue}°`;
}
function applyHofHex(value){
    let hex=String(value||'').trim().toUpperCase(); if(!hex.startsWith('#')) hex='#'+hex;
    if(/^#[0-9A-F]{6}$/.test(hex)){ const input=document.getElementById('hofColour'); if(input) input.value=hex; applyHofCustomColour(hex); updateHofColourMeta(hex); }
}
function resetHofColour(){
    const hex='#FF19B7'; const input=document.getElementById('hofColour'); if(input) input.value=hex; applyHofCustomColour(hex); updateHofColourMeta(hex);
}

function selectHofFrame(key){
    const composer=document.getElementById('hofComposer'); if(!composer) return;
    composer.dataset.frame=key;
    const colour=document.getElementById('hofColour')?.value || '#ff19b7';
    const intensity=Math.max(0,Math.min(100,Number(document.getElementById('hofIntensity')?.value || 100)))/100;
    composer.style.setProperty('--hof-custom', colour);
    composer.style.setProperty('--hof-intensity', intensity);
    document.querySelectorAll('.hof-frame-chip').forEach(b=>b.classList.toggle('active',b.dataset.hofFrame===key));
    const img=document.getElementById('hofFrameImage'); if(img) img.src=hofFrameAsset(key);
    composer.classList.remove('hof-effect-wheel','hof-effect-fire','hof-effect-rainbow','hof-effect-custom');
    if(key==='colour-wheel') composer.classList.add('hof-effect-wheel');
    if(key==='fire') composer.classList.add('hof-effect-fire');
    if(key==='rainbow') composer.classList.add('hof-effect-rainbow');
    if(key==='custom') composer.classList.add('hof-effect-custom');
}
function applyHofCustomColour(value){
    const composer=document.getElementById('hofComposer'); if(!composer)return;
    const hex=String(value||'#FF19B7').toUpperCase();
    composer.style.setProperty('--hof-custom',hex);
    const input=document.getElementById('hofColour'); if(input && input.value!==hex) input.value=hex;
    updateHofColourMeta(hex);
    if(composer.dataset.frame==='custom') selectHofFrame('custom');
}
function applyHofCustomIntensity(value){
    const composer=document.getElementById('hofComposer'); if(!composer)return;
    const intensity=Math.max(0,Math.min(100,Number(value)||0));
    composer.style.setProperty('--hof-intensity',`${intensity/100}`);
    const label=document.getElementById('hofIntensityValue'); if(label) label.textContent=`${intensity}%`;
}
function resetHofPhoto(){
    const img=document.getElementById('hofWinnerPhoto'); if(!img)return;
    img.style.setProperty('--hof-scale','1'); img.style.setProperty('--hof-x','0px'); img.style.setProperty('--hof-y','0px');
}

async function removeHofPhoto(){
    if(!canManage()) return;
    const current=ixData.hof?.[0];
    if(!current?.id){
        const win=document.getElementById('hofPhotoWindow');
        if(win) win.innerHTML='<span class="hof-photo-placeholder">Add winner photo</span>';
        return;
    }
    if(!confirm('Remove the Hall of Fame winner photo?')) return;
    const {error}=await supabaseClient.from('ix_hall_of_fame').update({
        image_url:null,
        photo_x:0,
        photo_y:0,
        photo_scale:1
    }).eq('id',current.id);
    if(error) return alert(error.message);
    await loadInteractionData();
    render();
}
function bindHofPhotoControls(){
    const win=document.getElementById('hofPhotoWindow'), img=document.getElementById('hofWinnerPhoto'); if(!win||!img)return;
    let dragging=false,sx=0,sy=0,ox=0,oy=0;
    win.onpointerdown=e=>{ if(!img.src)return; dragging=true;sx=e.clientX;sy=e.clientY;ox=parseFloat(img.style.getPropertyValue('--hof-x'))||0;oy=parseFloat(img.style.getPropertyValue('--hof-y'))||0;win.setPointerCapture?.(e.pointerId); };
    win.onpointermove=e=>{ if(!dragging)return; img.style.setProperty('--hof-x',`${ox+e.clientX-sx}px`);img.style.setProperty('--hof-y',`${oy+e.clientY-sy}px`); };
    win.onpointerup=()=>dragging=false; win.onpointercancel=()=>dragging=false;
    win.onwheel=e=>{ if(!img.src)return;e.preventDefault();const current=parseFloat(img.style.getPropertyValue('--hof-scale'))||1;const next=Math.max(.5,Math.min(3,current+(e.deltaY<0?.08:-.08)));img.style.setProperty('--hof-scale',next); };
}
async function saveHallOfFame(){
    if(!canManage())return;
    let winner_name=document.getElementById('hofWinnerName')?.value.trim();
    const winner_discord_id=document.getElementById('hofWinnerDiscordId')?.value.trim() || '';
    let winnerStaff=(staff||[]).find(x => (winner_discord_id && String(x.discord_id||'')===winner_discord_id) || (winner_name && String(x.name||'').toLowerCase()===winner_name.toLowerCase()));
    if(!winner_name && winnerStaff) winner_name=winnerStaff.name;
    if(!winner_name && !winner_discord_id) return alert('Enter a winner name or Discord ID.');
    if(winner_discord_id && !winnerStaff) return alert('That Discord ID is not linked to a staff record. Check the ID or add the person to the staff directory first.');
    if(winnerStaff && !winner_name) winner_name=winnerStaff.name;
    const image_url=document.getElementById('hofWinnerPhoto')?.src || '';
    const composer=document.getElementById('hofComposer');
    const frame=composer?.dataset.frame || 'original';
    const frame_colour=document.getElementById('hofColour')?.value||'#ff19b7';
    const intensity=Number(document.getElementById('hofIntensity')?.value||100);
    const photo=document.getElementById('hofWinnerPhoto');
    const photo_x=parseFloat(photo?.style.getPropertyValue('--hof-x'))||0;
    const photo_y=parseFloat(photo?.style.getPropertyValue('--hof-y'))||0;
    const photo_scale=parseFloat(photo?.style.getPropertyValue('--hof-scale'))||1;
    const frame_mode=['colour-wheel','fire','rainbow','custom'].includes(frame)?frame:'none';
    const hue=hofHueFromHex(frame_colour);
    const payload={winner_name:winner_name||winner_discord_id,winner_discord_id:winnerStaff?.discord_id || winner_discord_id || null,winner_staff_id:winnerStaff?.id || null,image_url,frame,frame_colour,frame_mode,hue,intensity,photo_x,photo_y,photo_scale,created_by:currentUser.id};
    const {error}=await supabaseClient.from('ix_hall_of_fame').insert(payload);
    if(error){
        if(String(error.message||'').toLowerCase().includes('schema cache') || String(error.message||'').toLowerCase().includes('does not exist')) {
            return showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">Hall of Fame</span><h2>Database setup required</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><p class="modal-message">The Hall of Fame table is not installed yet. Run <b>KNG-ENTERTAINMENT-COMPLETE-MIGRATION.sql</b> in Supabase, then refresh the site.</p><div class="modal-footer"><button class="primary-button" onclick="closeModal()">Close</button></div></div>`);
        }
        return alert(error.message);
    }
    await loadInteractionData(); render();
}
async function downloadHallOfFame(){
    const composer=document.getElementById('hofComposer'); const frameImg=document.getElementById('hofFrameImage'); if(!composer||!frameImg)return;
    const canvas=document.createElement('canvas'); const w=1428,h=1806; canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');
    const frame=new Image();frame.crossOrigin='anonymous';frame.src=frameImg.src;await new Promise(r=>{frame.onload=r;frame.onerror=r});ctx.drawImage(frame,0,0,w,h);
    const photo=document.getElementById('hofWinnerPhoto'); if(photo?.src){ const p=new Image();p.crossOrigin='anonymous';p.src=photo.src;await new Promise(r=>{p.onload=r;p.onerror=r});
      const win={x:182,y:654,w:1089,h:820};const scale=parseFloat(photo.style.getPropertyValue('--hof-scale'))||1;const x=parseFloat(photo.style.getPropertyValue('--hof-x'))||0;const y=parseFloat(photo.style.getPropertyValue('--hof-y'))||0;ctx.save();ctx.beginPath();ctx.rect(win.x,win.y,win.w,win.h);ctx.clip();const size=Math.max(win.w,win.h)*scale;ctx.drawImage(p,win.x+(win.w-size)/2+x,win.y+(win.h-size)/2+y,size,size);ctx.restore(); }
    const a=document.createElement('a');a.download=`KNG-Hall-of-Fame-${(document.getElementById('hofWinnerName')?.value||'Winner').replace(/[^a-z0-9_-]+/gi,'-')}.png`;a.href=canvas.toDataURL('image/png');a.click();
}
function openHofUpload(){
    if(!canManage()) return; const input=document.createElement('input'); input.type='file'; input.accept='image/*';
    input.onchange=async()=>{ const file=input.files?.[0]; if(!file)return; const ext=(file.name.split('.').pop()||'jpg').toLowerCase(); const path=`${currentUser.id}/${Date.now()}.${ext}`; const {error}=await supabaseClient.storage.from('kng-hall-of-fame').upload(path,file,{upsert:false,contentType:file.type}); if(error)return alert(error.message); const {data}=supabaseClient.storage.from('kng-hall-of-fame').getPublicUrl(path); const old=document.getElementById('hofPhotoWindow'); if(old){old.innerHTML=`<img id="hofWinnerPhoto" class="hof-winner-photo" src="${escapeHtml(data.publicUrl)}" alt="Winner" style="--hof-scale:1;--hof-x:0px;--hof-y:0px">`;bindHofPhotoControls();} };
    input.click();
}


/* =========================================================
   ACTIONS WORKSPACE
   ========================================================= */

async function loadActionData(){
    if(!currentUser){ actionData={tracker:[],br:[],logs:[],goals:[],types:[]}; return; }
    const load = async (key, query) => {
        try { const r=await query(); if(r.error) throw r.error; actionLoadErrors[key]=null; return r.data||[]; }
        catch(e){ actionLoadErrors[key]=e?.message||String(e); return []; }
    };
    const [tracker, br, logs, goals, types] = await Promise.all([
        load('action_tracker',()=>supabaseClient.from('kng_action_tracker').select('*').order('event_date',{ascending:false}).order('created_at',{ascending:false}).limit(500)),
        load('action_br_tracker',()=>supabaseClient.from('kng_action_br_tracker').select('*').order('event_date',{ascending:false}).order('created_at',{ascending:false}).limit(300)),
        load('action_log',()=>supabaseClient.from('kng_action_logs').select('*, staff:staff_id(id,name,discord_id)').order('created_at',{ascending:false}).limit(500)),
        load('action_goals',()=>supabaseClient.from('kng_action_goals').select('*').order('goal_month',{ascending:false}).limit(24)),
        load('action_types',()=>supabaseClient.from('kng_action_types').select('*').eq('active',true).order('kind').order('name'))
    ]);
    actionData={tracker,br,logs,goals,types};
}

function actionTypes(kind){ return (actionData.types||[]).filter(t=>!kind||t.kind===kind); }
function actionTypeOptions(kind, selected=''){
    return actionTypes(kind).map(t=>`<option value="${escapeAttribute(t.name)}" ${String(t.name)===String(selected)?'selected':''}>${escapeHtml(t.name)}</option>`).join('');
}
function actionErrorNotice(key){ const e=actionLoadErrors[key]; return e?`<div class="ops-notice warning">${escapeHtml(key)} is not available yet. Run <code>KNG-ACTIONS-WORKSPACE-PATCH.sql</code>. <small>${escapeHtml(e)}</small></div>`:''; }
function actionStaffNames(){ return staff.map(s=>s.name).filter(Boolean); }
function parseAttendees(value){ return String(value||'').split(/[,\n]/).map(x=>x.trim()).filter(Boolean); }
function actionMonthKey(date=new Date()){ return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`; }
function actionDateLabel(d){ const dt=new Date(`${String(d).slice(0,10)}T00:00:00`); return Number.isNaN(dt.getTime())?String(d||''):dt.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'2-digit'}); }
function actionEventTypesForForm(){ return actionTypes('action'); }

function renderHostAction(){
    if(!canUseTeam('actions')) return `<div class="ix-panel"><div class="ix-empty">Actions workspace access required.</div></div>`;
    const options=actionEventTypesForForm();
    return `<div class="action-page"><section class="actions-dashboard-hero"><div><span class="host-eyebrow">ACTIONS WORKSPACE</span><h2>Host an Action</h2><p>Submit an Actions event. Members can submit; AUX+ can approve it and place it onto the shared KNG schedule.</p></div><div class="actions-dashboard-badge">🎯 ACTION</div></section>
    <div class="ops-grid-two"><section class="ops-card"><div class="ops-card-head"><h3>Submit an Action</h3><span class="ops-subtle">Approval required</span></div><form id="actionSubmissionForm" class="ops-form"><label>Action type<select name="type" required><option value="">Select action</option>${options.map(t=>`<option value="${escapeAttribute(t.name)}">${escapeHtml(t.name)}</option>`).join('')}</select></label><label>Title<input name="title" maxlength="120" placeholder="e.g. Humane Labs" required></label><div class="form-grid"><label>Date<input type="date" name="event_date" value="${formatDate(new Date())}" required></label><label>Start<input type="time" name="start_time" value="19:00" required></label><label>End<input type="time" name="end_time" value="20:00" required></label></div><label>Notes<textarea name="description" rows="4" maxlength="1000" placeholder="Staff notes, location, requirements..."></textarea></label><button class="primary-button">Submit for Approval</button><small>All staff levels can submit. AUX, ADM, Management and Directors can approve.</small></form></section>
    <section class="ops-card"><div class="ops-card-head"><h3>Approval Queue</h3><span class="ops-pill">${canApproveEvents()?'AUX+ CAN APPROVE':'VIEW ONLY'}</span></div><div class="ops-list">${(ixData.eventSubmissions||[]).filter(s=>s.status==='pending').slice(0,8).map(s=>`<div class="ops-row"><div><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.display_name||'Staff')} · ${formatOpsDateTime(s.created_at)}</small></div>${canApproveEvents()?`<button class="mini-btn" onclick="openApproveEventSubmission('${s.id}')">APPROVE</button>`:''}</div>`).join('')||`<div class="ops-empty">No pending action submissions.</div>`}</div></section></div></div>`;
}

function renderActionSchedule(){
    const actionEvents=(allEvents||[]).filter(e=>String(e.workspace||'').toLowerCase()==='actions' && e.status!=='cancelled').sort((a,b)=>String(a.event_date).localeCompare(String(b.event_date))||String(a.start_time).localeCompare(String(b.start_time)));
    const byDay={}; actionEvents.forEach(e=>(byDay[e.event_date] ||= []).push(e));
    const days=Object.keys(byDay).slice(0,14);
    return `<div class="action-page"><section class="actions-dashboard-hero"><div><span class="host-eyebrow">ACTIONS SCHEDULE</span><h2>Action Schedule</h2><p>The Actions view of the shared KNG calendar. Approved actions live here and on the main Schedule.</p></div><button class="primary-button" onclick="switchOpsView('host-action')">+ Submit Action</button></section>${days.length?days.map(d=>`<section class="ops-card action-day-card"><div class="ops-card-head"><h3>${actionDateLabel(d)}</h3><span class="ops-subtle">${byDay[d].length} action${byDay[d].length===1?'':'s'}</span></div><div class="action-schedule-grid">${byDay[d].map(e=>`<article class="action-schedule-event" style="--action-colour:${escapeAttribute(e.event_types?.colour||'#ef334f')}"><strong>${escapeHtml(e.title)}</strong><span>${formatTime(e.start_time)} - ${formatTime(e.end_time)}</span><small>${escapeHtml(e.event_types?.name||'Action')}</small></article>`).join('')}</div></section>`).join(''):`<div class="ops-card"><div class="ops-empty">No approved Actions are on the shared schedule yet.</div></div>`}</div>`;
}

function renderActionTracker(){
    const rows=actionData.tracker||[];
    return `<div class="action-page action-table-page">${actionErrorNotice('action_tracker')}<section class="ops-card"><div class="ops-card-head"><div><h3>Actions Tracker</h3><small>Completed action records, matching the tracker workflow from your video.</small></div><div class="ops-actions"><button class="primary-button" onclick="openActionTrackerModal()">+ Add row</button><span class="ops-pill">${rows.length} actions</span></div></div><div class="action-table-wrap"><table class="action-table"><thead><tr><th>Date</th><th>Type</th><th>Status</th><th>ORG 1</th><th>ORG 2</th><th>Attended</th><th>Winner</th><th>ORG 1 #</th><th>ORG 2 #</th><th>IDs</th><th>Comped</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${actionDateLabel(r.event_date)}</td><td><span class="action-type-chip" style="--action-colour:${escapeAttribute(actionTypes('action').find(t=>t.name===r.action_type)?.colour||'#ef334f')}">${escapeHtml(r.action_type||'')}</span></td><td>${escapeHtml(r.status||'')}</td><td>${escapeHtml(r.org1||'')}</td><td>${escapeHtml(r.org2||'')}</td><td>${escapeHtml(parseAttendees(r.attended).length?parseAttendees(r.attended).length+' selected':'0 selected')}</td><td>${escapeHtml(r.winner||'N/A')}</td><td>${Number(r.org1_count||0)}</td><td>${Number(r.org2_count||0)}</td><td class="action-ids-cell">${escapeHtml(r.ids||'')}</td><td>${r.winner_comped?'☑':'☐'}</td><td>${canUseTeam('actions')?`<button class="mini-btn" onclick="editActionTrackerRow('${r.id}')">EDIT</button>`:''}</td></tr>`).join('')||`<tr><td colspan="12"><div class="ops-empty">No actions recorded yet.</div></td></tr>`}</tbody></table></div></section></div>`;
}

function renderActionBrTracker(){
    const rows=actionData.br||[];
    return `<div class="action-page action-table-page">${actionErrorNotice('action_br_tracker')}<section class="ops-card"><div class="ops-card-head"><div><h3>Battle Royale Tracker</h3><small>Separate BR tracking, just like the reference tracker.</small></div><div class="ops-actions"><button class="primary-button" onclick="openBrTrackerModal()">+ Add row</button><span class="ops-pill">${rows.length} BRs</span></div></div><div class="action-table-wrap"><table class="action-table"><thead><tr><th>Date</th><th>Type</th><th>Status</th><th>Attended</th><th>1st Place</th><th>Winner Comped</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${actionDateLabel(r.event_date)}</td><td><span class="action-type-chip" style="--action-colour:${escapeAttribute(actionTypes('br').find(t=>t.name===r.action_type)?.colour||'#9b2c5e')}">${escapeHtml(r.action_type||'')}</span></td><td>${escapeHtml(r.status||'')}</td><td>${escapeHtml(parseAttendees(r.attended).length?parseAttendees(r.attended).length+' selected':'0 selected')}</td><td>${escapeHtml(r.first_place||'')}</td><td>${r.winner_comped?'☑':'☐'}</td><td>${canUseTeam('actions')?`<button class="mini-btn" onclick="editBrTrackerRow('${r.id}')">EDIT</button>`:''}</td></tr>`).join('')||`<tr><td colspan="7"><div class="ops-empty">No BRs recorded yet.</div></td></tr>`}</tbody></table></div></section></div>`;
}

function renderActionLog(){
    const logs=actionData.logs||[];
    return `<div class="action-page"><section class="ops-card action-log-form-card"><div class="ops-card-head"><h3>Log an action</h3><span class="ops-subtle">Record positive or negative activity</span></div><form id="actionLogForm" class="ops-form"><label>Organisation<select name="organisation"><option value="">—</option>${actionStaffNames().map(n=>`<option>${escapeHtml(n)}</option>`).join('')}</select></label><label>Action<input name="action" maxlength="160" required placeholder="What happened?"></label><label>Result<div class="result-toggle"><label><input type="radio" name="result" value="Positive" checked> Positive</label><label><input type="radio" name="result" value="Negative"> Negative</label></div></label><label>Numbers / why<textarea name="numbers" rows="3" placeholder="Positive: who was involved / numbers. Negative: why it was negative."></textarea></label><label>Proof URL<input name="proof_url" type="url" placeholder="https://..."></label><button class="primary-button">Submit log</button></form></section>${opsCard('Your logs',logs.filter(l=>!l.staff_id || String(l.staff_id)===String(getCurrentStaffRecord()?.id||'' )).length?`<div class="action-log-list">${logs.filter(l=>!l.staff_id || String(l.staff_id)===String(getCurrentStaffRecord()?.id||'')).slice(0,50).map(l=>`<div class="action-log-row"><span>${formatOpsDateTime(l.created_at)}</span><b>${escapeHtml(l.organisation||'—')}</b><b>${escapeHtml(l.action)}</b><span class="result-pill ${String(l.result).toLowerCase()}">${escapeHtml(l.result)}</span><span>${escapeHtml(l.numbers||'')}</span>${l.proof_url?`<a href="${escapeAttribute(l.proof_url)}" target="_blank" rel="noopener">Proof</a>`:''}</div>`).join('')}</div>`:`<div class="ops-empty">No logs yet.</div>`)}</div>`;
}

function renderActionStats(){
    const month=actionMonthKey(); const rows=(actionData.tracker||[]).filter(r=>String(r.event_date||'').slice(0,7)===month); const completed=rows.filter(r=>String(r.status||'').toLowerCase()==='completed').length; const compRate=rows.length?Math.round(completed/rows.length*100):0; const attendees=rows.reduce((n,r)=>n+parseAttendees(r.attended).length,0); const winners=rows.filter(r=>r.winner && String(r.winner).toLowerCase()!=='n/a').length; const org1=rows.reduce((n,r)=>n+Number(r.org1_count||0),0); const org2=rows.reduce((n,r)=>n+Number(r.org2_count||0),0); const typeCounts={}; rows.forEach(r=>typeCounts[r.action_type]=(typeCounts[r.action_type]||0)+1); const types=Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]); return `<div class="action-page"><div class="ops-stats-grid"><div class="ops-stat"><span>Actions Logged</span><strong>${rows.length}</strong><small>${month}</small></div><div class="ops-stat"><span>Finished Cleanly</span><strong>${compRate}%</strong><small>${completed} completed</small></div><div class="ops-stat"><span>Total Attendance</span><strong>${attendees}</strong><small>attendee records</small></div><div class="ops-stat"><span>Winners</span><strong>${winners}</strong><small>records with a winner</small></div></div><div class="ops-grid-two"><section class="ops-card"><div class="ops-card-head"><h3>Win rate</h3><span class="ops-subtle">Org 1 vs Org 2</span></div><div class="action-stat-pair"><div><strong>${org1+org2?Math.round(org1/(org1+org2)*100):0}%</strong><small>ORG 1</small></div><div><strong>${org1+org2?Math.round(org2/(org1+org2)*100):0}%</strong><small>ORG 2 / PD</small></div></div></section><section class="ops-card"><div class="ops-card-head"><h3>Most played types</h3></div><div class="ops-list">${types.slice(0,8).map(([name,count])=>`<div class="ops-row"><b>${escapeHtml(name)}</b><span class="ops-pill">${count}</span></div>`).join('')||`<div class="ops-empty">No action data for this month.</div>`}</div></section></div></div>`;
}

function renderTeamPointsLeaderboard(team){
    const totals=new Map();
    for(const p of (ops.points||[]).filter(x=>String(x.team||'interactions').toLowerCase()===team)){
        const id=String(p.staff_id||''); if(!id) continue;
        const row=totals.get(id)||{name:p.staff?.name||staff.find(s=>String(s.id)===id)?.name||'Unknown',total:0};
        row.total+=Number(p.amount||0); totals.set(id,row);
    }
    const rows=[...totals.values()].sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name));
    const body=rows.length?`<div class="leaderboard">${rows.slice(0,25).map((r,i)=>`<div class="leader-row"><span class="rank">${i+1}</span><b>${escapeHtml(r.name)}</b><strong>${r.total}</strong></div>`).join('')}</div>`:`<div class="ops-empty">No ${team} points have been awarded yet.</div>`;
    return opsCard(`${team==='actions'?'Actions':'Interactions'} points leaderboard`,body,`<span class="ops-subtle">Points awarded to this team</span>`);
}

function renderActionLeaderboard(){
    const month=actionMonthKey();
    const monthRows=(actionData.tracker||[]).filter(r=>String(r.event_date||'').slice(0,7)===month);
    const completed=monthRows.filter(r=>String(r.status||'').toLowerCase()==='completed').length;
    const compRate=monthRows.length?Math.round(completed/monthRows.length*100):0;
    const attendees=monthRows.reduce((n,r)=>n+parseAttendees(r.attended).length,0);
    const winners=monthRows.filter(r=>r.winner && String(r.winner).toLowerCase()!=='n/a').length;
    const org1=monthRows.reduce((n,r)=>n+Number(r.org1_count||0),0);
    const org2=monthRows.reduce((n,r)=>n+Number(r.org2_count||0),0);
    const typeCounts={};
    monthRows.forEach(r=>{ typeCounts[r.action_type]=(typeCounts[r.action_type]||0)+1; });
    const types=Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]);
    const goal=(actionData.goals||[]).find(g=>String(g.goal_month).slice(0,7)===month) || {target_actions:47,notes:''};
    const target=Math.max(1,Number(goal.target_actions||1));
    const actual=monthRows.length;
    const pct=Math.min(100,Math.round(actual/target*100));

    const map=new Map();
    const today=new Date();
    const start=new Date(today);
    start.setDate(start.getDate()-30);
    for(const r of actionData.tracker||[]){
        const d=new Date(`${String(r.event_date).slice(0,10)}T00:00:00`);
        if(Number.isNaN(d.getTime())||d<start) continue;
        for(const n of parseAttendees(r.attended)){
            const k=n.toLowerCase();
            const x=map.get(k)||{name:n,total:0};
            x.total++;
            map.set(k,x);
        }
    }
    const rows=[...map.values()].sort((a,b)=>b.total-a.total);

    return `<div class="action-page action-performance-page">
        <section class="ops-card action-goal-summary-card">
            <div class="ops-card-head"><div><h3>Action Goals</h3><small>Monthly team target · ${escapeHtml(month)}</small></div>${canManage()?`<button class="primary-button" onclick="openActionGoalModal()">Set goal</button>`:''}</div>
            <div class="goal-hero"><div><span>THIS MONTH</span><strong>${actual} / ${target}</strong><small>actions logged</small></div><div class="goal-progress"><div style="width:${pct}%"></div></div><strong>${pct}%</strong></div>
            <p class="ops-muted">${escapeHtml(goal.notes||'Keep the Actions team moving.')}</p>
        </section>

        <section class="ops-card action-leaderboard-card"><div class="ops-card-head"><div><h3>Leaderboard</h3><small>Rolling 30-day Actions attendance</small></div><span class="ops-pill">${rows.length} people</span></div><div class="action-leaderboard">${rows.slice(0,50).map((r,i)=>`<div class="action-leader-row"><span>#${String(i+1).padStart(2,'0')}</span><div class="avatar">${escapeHtml((r.name||'?').slice(0,2).toUpperCase())}</div><b>${escapeHtml(r.name)}</b><strong>${r.total}</strong></div>`).join('')||`<div class="ops-empty">No attendance data yet.</div>`}</div></section>
        ${renderTeamPointsLeaderboard('actions')}

    </div>`;
}

function renderActionGoals(){
    const month=actionMonthKey(); const goal=(actionData.goals||[]).find(g=>String(g.goal_month).slice(0,7)===month) || {target_actions:47,notes:''}; const actual=(actionData.tracker||[]).filter(r=>String(r.event_date||'').slice(0,7)===month).length; const target=Math.max(1,Number(goal.target_actions||1)); const pct=Math.min(100,Math.round(actual/target*100)); return `<div class="action-page"><section class="ops-card"><div class="ops-card-head"><div><h3>Action goals</h3><small>Monthly team target</small></div>${canManage()?`<button class="primary-button" onclick="openActionGoalModal()">Set goal</button>`:''}</div><div class="goal-hero"><div><span>THIS MONTH</span><strong>${actual} / ${target}</strong><small>actions logged</small></div><div class="goal-progress"><div style="width:${pct}%"></div></div><strong>${pct}%</strong></div><p class="ops-muted">${escapeHtml(goal.notes||'Keep the Actions team moving.')}</p></section></div>`;
}

function renderActionUsers(){
    const rows=(rosterData||[]).filter(r=>r.team==='actions'&&r.active!==false).sort((a,b)=>rosterLevelRank(b.hierarchy_level)-rosterLevelRank(a.hierarchy_level)||getRosterDisplayName(a).localeCompare(getRosterDisplayName(b))); return `<div class="action-page"><section class="ops-card"><div class="ops-card-head"><div><h3>Actions Users</h3><small>Actions roster and hierarchy</small></div><span class="ops-pill">${rows.length} staff</span></div><div class="action-users-table"><div class="action-users-head"><span>Name</span><span>Level</span><span>Site access</span><span>Mentor</span></div>${rows.map(r=>`<div class="action-users-row"><b>${escapeHtml(getRosterDisplayName(r))}</b><span>${escapeHtml(rosterLevelLabel(r.hierarchy_level,'actions'))}</span><span>${escapeHtml(r.hierarchy_level==='manager'||r.hierarchy_level==='director'||r.hierarchy_level==='culture_manager'||r.hierarchy_level==='entertainment_resp'||r.hierarchy_level==='adm'||r.hierarchy_level==='aux'?r.hierarchy_level.toUpperCase().replace('_',' '):'MEMBER')}</span><span>${r.mentor?'Yes':'No'}</span></div>`).join('')||`<div class="ops-empty">No Actions staff are allocated.</div>`}</div></section></div>`;
}

function openActionTrackerModal(id=''){
    const r=(actionData.tracker||[]).find(x=>String(x.id)===String(id))||{}; const title=id?'Edit action':'Add action'; showModal(`<div class="modal"><div class="modal-header"><div><span class="modal-eyebrow">ACTIONS TRACKER</span><h2>${title}</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><form id="actionTrackerForm" class="ops-form"><div class="form-grid"><label>Date<input type="date" name="event_date" value="${escapeAttribute(r.event_date||formatDate(new Date()))}" required></label><label>Type<select name="action_type" required><option value="">Select action</option>${actionTypeOptions('action',r.action_type)}</select></label><label>Status<select name="status"><option ${r.status==='Completed'?'selected':''}>Completed</option><option ${r.status==='No-show'?'selected':''}>No-show</option><option ${r.status==='Cancelled'?'selected':''}>Cancelled</option><option ${r.status==='Scheduled'?'selected':''}>Scheduled</option></select></label><label>ORG 1<input name="org1" value="${escapeAttribute(r.org1||'')}" placeholder="Crystal Cartel"></label><label>ORG 2<input name="org2" value="${escapeAttribute(r.org2||'')}" placeholder="PD"></label><label>Winner<input name="winner" list="actionWinnerNames" value="${escapeAttribute(r.winner||'')}" placeholder="Type winner name or Discord ID"><datalist id="actionWinnerNames">${actionStaffNames().map(n=>`<option value="${escapeAttribute(n)}"></option>`).join('')}</datalist></label><label>ORG 1 #<input type="number" name="org1_count" min="0" value="${Number(r.org1_count||0)}"></label><label>ORG 2 #<input type="number" name="org2_count" min="0" value="${Number(r.org2_count||0)}"></label><label class="form-field full">Attended<textarea name="attended" rows="3" placeholder="Names, comma separated">${escapeHtml(r.attended||'')}</textarea></label><label class="form-field full">IDs<textarea name="ids" rows="2" placeholder="Discord IDs, comma separated">${escapeHtml(r.ids||'')}</textarea></label><label><input type="checkbox" name="winner_comped" ${r.winner_comped?'checked':''}> Winner comped</label></div><div class="modal-footer"><button type="button" class="secondary-button" onclick="closeModal()">Cancel</button><button class="primary-button">Save</button></div></form></div>`); document.getElementById('actionTrackerForm')?.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target).entries());const payload={event_date:d.event_date,action_type:d.action_type,status:d.status,org1:d.org1,org2:d.org2,attended:d.attended,winner:d.winner,org1_count:Number(d.org1_count||0),org2_count:Number(d.org2_count||0),ids:d.ids,winner_comped:e.target.winner_comped.checked,updated_by:currentUser.id};const q=id?supabaseClient.from('kng_action_tracker').update(payload).eq('id',id):supabaseClient.from('kng_action_tracker').insert({...payload,created_by:currentUser.id});const {error}=await q;if(error)return alert(error.message);closeModal();await loadActionData();render();});
}
function editActionTrackerRow(id){ openActionTrackerModal(id); }
function openBrTrackerModal(id=''){ const r=(actionData.br||[]).find(x=>String(x.id)===String(id))||{}; showModal(`<div class="modal"><div class="modal-header"><div><span class="modal-eyebrow">BR TRACKER</span><h2>${id?'Edit BR':'Add BR'}</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><form id="brTrackerForm" class="ops-form"><div class="form-grid"><label>Date<input type="date" name="event_date" value="${escapeAttribute(r.event_date||formatDate(new Date()))}" required></label><label>Type<select name="action_type" required><option value="">Select BR</option>${actionTypeOptions('br',r.action_type)}</select></label><label>Status<select name="status"><option>Completed</option><option>No-show</option><option>Cancelled</option><option>Scheduled</option></select></label><label>1st place<input name="first_place" value="${escapeAttribute(r.first_place||'')}"></label><label class="form-field full">Attended<textarea name="attended" rows="4">${escapeHtml(r.attended||'')}</textarea></label><label><input type="checkbox" name="winner_comped" ${r.winner_comped?'checked':''}> Winner comped</label></div><div class="modal-footer"><button type="button" class="secondary-button" onclick="closeModal()">Cancel</button><button class="primary-button">Save</button></div></form></div>`); document.getElementById('brTrackerForm')?.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target).entries());const payload={event_date:d.event_date,action_type:d.action_type,status:d.status,attended:d.attended,first_place:d.first_place,winner_comped:e.target.winner_comped.checked,updated_by:currentUser.id};const q=id?supabaseClient.from('kng_action_br_tracker').update(payload).eq('id',id):supabaseClient.from('kng_action_br_tracker').insert({...payload,created_by:currentUser.id});const {error}=await q;if(error)return alert(error.message);closeModal();await loadActionData();render();}); }
function editBrTrackerRow(id){openBrTrackerModal(id);}
function openActionGoalModal(){ const month=actionMonthKey(); const g=(actionData.goals||[]).find(x=>String(x.goal_month).slice(0,7)===month)||{}; showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">ACTIONS GOAL</span><h2>Set monthly goal</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><form id="actionGoalForm" class="ops-form"><label>Month<input type="month" name="goal_month" value="${month}" required></label><label>Target actions<input type="number" name="target_actions" min="1" value="${Number(g.target_actions||47)}" required></label><label>Notes<textarea name="notes" rows="3">${escapeHtml(g.notes||'')}</textarea></label><button class="primary-button">Save goal</button></form></div>`); document.getElementById('actionGoalForm')?.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target).entries());const {error}=await supabaseClient.from('kng_action_goals').upsert({goal_month:`${d.goal_month}-01`,target_actions:Number(d.target_actions),notes:d.notes,created_by:currentUser.id},{onConflict:'goal_month'});if(error)return alert(error.message);closeModal();await loadActionData();render();}); }

async function submitActionEvent(e){
    e.preventDefault();
    if(!canSubmitEvents()) return openLogin();
    const d=Object.fromEntries(new FormData(e.target).entries());
    if(d.end_time<=d.start_time) return alert('End time must be later than start time.');
    const {error}=await supabaseClient.from('kng_event_submissions').insert({submitted_by:currentUser.id,display_name:getKngDisplayName(),workspace:'actions',title:d.title.trim(),event_type:d.type,event_date:d.event_date,start_time:d.start_time,end_time:d.end_time,description:d.description||null,status:'pending'});
    if(error)return alert(error.message);
    await loadInteractionData(); render();
}

function openApproveEventSubmission(id){
    if(!canApproveEvents())return;
    const s=(ixData.eventSubmissions||[]).find(x=>String(x.id)===String(id));
    if(!s)return;
    const selectedType=(eventTypes||[]).find(t=>String(t.name).toLowerCase()===String(s.event_type||'').toLowerCase());
    const opts=(eventTypes||[]).map(t=>`<option value="${escapeAttribute(t.id)}" ${selectedType?.id===t.id?'selected':''}>${escapeHtml(t.name)}</option>`).join('');
    showModal(`<div class="modal"><div class="modal-header"><div><span class="modal-eyebrow">EVENT APPROVAL</span><h2>Approve & Schedule</h2><small>${escapeHtml(s.title)}</small></div><button class="modal-close" onclick="closeModal()">×</button></div><form id="approveEventForm" class="ops-form"><label>Title<input name="title" value="${escapeAttribute(s.title)}" required></label><label>Event type<select name="event_type_id" required>${opts}</select></label><div class="form-grid"><label>Date<input type="date" name="event_date" value="${escapeAttribute(s.event_date)}" required></label><label>Start<input type="time" name="start_time" value="${escapeAttribute(String(s.start_time).slice(0,5))}" required></label><label>End<input type="time" name="end_time" value="${escapeAttribute(String(s.end_time).slice(0,5))}" required></label></div><label>Workspace<select name="workspace"><option value="general" ${s.workspace==='general'?'selected':''}>General</option><option value="actions" ${s.workspace==='actions'?'selected':''}>Actions</option><option value="interactions" ${s.workspace==='interactions'?'selected':''}>Interactions</option></select></label><label>Approval note<textarea name="note" rows="3">${escapeHtml(s.description||'')}</textarea></label><button class="primary-button">Approve & Add to Schedule</button></form></div>`);
    document.getElementById('approveEventForm')?.addEventListener('submit',async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target).entries());const {error}=await supabaseClient.rpc('approve_kng_event_submission',{p_submission_id:id,p_event_type_id:d.event_type_id,p_workspace:d.workspace,p_title:d.title,p_event_date:d.event_date,p_start_time:d.start_time,p_end_time:d.end_time,p_note:d.note||null});if(error)return alert(error.message);closeModal();await loadEvents();await loadInteractionData();render();});
}
async function declineEventSubmission(id){ if(!canApproveEvents())return; const note=prompt('Reason for rejecting this submission:','Not approved'); if(note===null)return; const {error}=await supabaseClient.rpc('reject_kng_event_submission',{p_submission_id:id,p_note:note}); if(error)return alert(error.message); await loadInteractionData(); render(); }

function renderPersonalDashboard(){
    const team = getCurrentEntertainmentTeam();
    const today = formatDate(new Date());
    const goal = ixData.goals.find(g => g.goal_date === today) || {target_points:8,points_earned:0};
    const earned = Number(goal.points_earned || 0);
    const target = Math.max(1, Number(goal.target_points || 8));
    const pct = Math.min(100, Math.round(earned / target * 100));
    const upcoming = getUpcomingDashboardEvents(6);
    const completed = (allEvents || []).filter(e => !e.is_meeting && isEventCompleted(e));
    const currentStaff = getCurrentStaffRecord();
    const myStaffId = currentStaff?.id ? String(currentStaff.id) : "";
    const myHosted = (allEvents || []).filter(e =>
        myStaffId && String(e.host_claimed_by || "") === myStaffId
    );
    const myAssigned = (allEvents || []).filter(e =>
        myStaffId && (e.event_staff || []).some(es => String(es.staff_id || "") === myStaffId)
    );
    const teamLabel = team === "interactions" ? "Interactions" : team === "actions" ? "Actions" : "KNG Staff";

    const completedHtml = completed.length
        ? `<div class="ops-list">${completed.slice(0,5).map((e,i)=>`<div class="ops-row"><div><b>#${i+1} · ${escapeHtml(e.title)}</b><small>${escapeHtml(e.event_date)} · ${escapeHtml(e.event_types?.name || "Event")}</small></div><span class="ops-pill">${Number(e.attendance_count || 0)} attended</span></div>`).join("")}</div>`
        : `<div class="ops-empty">No completed events yet.</div>`;

    const upcomingHtml = upcoming.length
        ? `<div class="ops-list personal-upcoming-list">${upcoming.map(e=>`<div class="ops-row"><div><b>${escapeHtml(e.title)}</b><small>${dashboardEventDateLabel(e)} · ${formatTime(e.start_time)} - ${formatTime(e.end_time)}</small></div><span class="ops-pill">${escapeHtml(e.event_types?.name || "Event")}</span></div>`).join("")}</div>`
        : `<div class="ops-empty">No upcoming events are currently scheduled.</div>`;

    const teamHtml = team === "interactions"
        ? `<div class="ix-two-col">
            ${ixPanel("My Hosting", myHosted.length ? `<div class="ops-list">${myHosted.slice(0,6).map(e=>`<div class="ops-row"><div><b>${escapeHtml(e.title)}</b><small>${escapeHtml(e.event_date)} · ${formatTime(e.start_time)}</small></div><span class="ops-pill">${e.status === "cancelled" ? "Cancelled" : "Hosted"}</span></div>`).join("")}</div>` : `<div class="ix-empty">You haven't claimed any event slots yet.</div>`, `<button class="header-button" onclick="switchOpsView('host-event')">Host an Event</button>`)}
            ${ixPanel("Hosting shortcuts", `<div class="ix-quick-grid"><button onclick="switchOpsView('current-host')">Current Host</button><button onclick="switchOpsView('hall-of-fame')">Hall of Fame</button><button onclick="switchOpsView('event-suggestions')">Suggest an Event</button><button onclick="switchOpsView('command-dashboard')">Command Dashboard</button></div>`)}
        </div>`
        : team === "actions"
        ? `<div class="ix-two-col">
            ${ixPanel("My Actions Work", myAssigned.length ? `<div class="ops-list">${myAssigned.slice(0,6).map(e=>`<div class="ops-row"><div><b>${escapeHtml(e.title)}</b><small>${escapeHtml(e.event_date)} · ${formatTime(e.start_time)}</small></div><span class="ops-pill">${escapeHtml(e.event_types?.name || "Event")}</span></div>`).join("")}</div>` : `<div class="ix-empty">No event assignments are currently attached to you.</div>`, `<button class="header-button" onclick="switchOpsView('actions-dashboard')">Actions Dashboard</button>`)}
            ${ixPanel("Actions shortcuts", `<div class="ix-quick-grid"><button onclick="switchOpsView('actions-dashboard')">Actions Dashboard</button><button onclick="switchOpsView('event-suggestions')">Suggest an Event</button><button onclick="switchOpsView('command-dashboard')">Command Dashboard</button><button onclick="switchOpsView('staff-roster')">Staff Roster</button></div>`)}
        </div>`
        : "";

    return `${ixSchemaNotice("ix_daily_goals")}<div class="personal-dashboard team-personal-dashboard">
        <section class="personal-team-hero">
            <div><span class="personal-team-eyebrow">${escapeHtml(teamLabel)} WORKSPACE</span><h2>Welcome back, ${escapeHtml(getKngDisplayName())}</h2><p>Your dashboard is tailored to your KNG team. Shared tools stay shared, while your working area follows your roster assignment.</p></div>
            <div class="personal-team-badge">${escapeHtml(String(team || "staff").toUpperCase())}</div>
        </section>
        <div class="personal-top-grid">
            <section class="ix-goal-card personal-goal-card"><div class="ix-ring" style="--pct:${pct}%"><div><strong>${earned}</strong><small>/ ${target}</small></div></div><h3>Daily Goal</h3><p>${pct>=100?'Goal completed. Nice work.':`You need ${Math.max(0,target-earned)} more points to hit today's target.`}</p><div class="ix-progress"><span style="width:${pct}%"></span></div><small>${pct}% complete</small>${isDirector()?`<button class="header-button" onclick="saveDailyGoal()">Set Target</button>`:''}</section>
            <div class="personal-stats-grid">
                <div class="ix-stat"><span>Upcoming</span><strong>${upcoming.length}</strong><small>next scheduled events</small></div>
                <div class="ix-stat"><span>Completed</span><strong>${completed.length}</strong><small>completed events</small></div>
                <div class="ix-stat"><span>My ${team === "interactions" ? "Hosted" : "Assignments"}</span><strong>${team === "interactions" ? myHosted.length : myAssigned.length}</strong><small>${team === "interactions" ? "claimed event slots" : "event allocations"}</small></div>
                <div class="ix-stat"><span>Ideas</span><strong>${(ixData.suggestions || []).length}</strong><small>community suggestions</small></div>
            </div>
        </div>
        ${teamHtml}
        <div class="ix-two-col personal-dashboard-grid">${ixPanel("Upcoming events",upcomingHtml,`<span class="ix-panel-note">Rolling from the current time</span>`)}${ixPanel("Recent completed events",completedHtml,`<span class="ix-panel-note">Latest completed activity</span>`)}</div>
    </div>`;
}


function renderCurrentHost(){
    const now = new Date();
    const live = (allEvents || [])
        .filter(e => !e.is_meeting && e.status !== "cancelled")
        .filter(e => {
            const start = new Date(`${e.event_date}T${String(e.start_time || "00:00").slice(0,5)}:00`);
            const end = new Date(`${e.event_date}T${String(e.end_time || e.start_time || "00:00").slice(0,5)}:00`);
            return start <= now && now < end && e.host_claimed_by;
        })
        .sort((a,b) => String(a.start_time).localeCompare(String(b.start_time)));

    const upcomingHosted = (allEvents || [])
        .filter(e => !e.is_meeting && e.status !== "cancelled" && e.host_claimed_by && new Date(`${e.event_date}T${String(e.start_time || "00:00").slice(0,5)}:00`) > now)
        .sort((a,b) => new Date(`${a.event_date}T${String(a.start_time || "00:00").slice(0,5)}:00`) - new Date(`${b.event_date}T${String(b.start_time || "00:00").slice(0,5)}:00`))
        .slice(0,8);

    const current = live[0] || upcomingHosted[0] || null;
    const currentStaff = current ? (staff || []).find(s => String(s.id || "") === String(current.host_claimed_by || "") || String(s.discord_id || "") === String(current.host_claimed_discord || "")) : null;
    const hostName = current?.host_claimed_name || currentStaff?.name || "Unclaimed";

    const liveHtml = current ? `<div class="current-host-card ${live[0] ? "is-live" : "is-upcoming"}">
        <div class="current-host-status">${live[0] ? "● LIVE NOW" : "UP NEXT"}</div>
        <h2>${escapeHtml(current.title)}</h2>
        <div class="current-host-meta"><span>${escapeHtml(current.event_date)}</span><span>${formatTime(current.start_time)} - ${formatTime(current.end_time)}</span><span>${escapeHtml(current.event_types?.name || "Event")}</span></div>
        <div class="current-host-person"><span>HOST</span><strong>${escapeHtml(hostName)}</strong></div>
        ${current.location ? `<div class="current-host-location">📍 ${escapeHtml(current.location)}</div>` : ""}
        <div class="current-host-actions">${currentUser && String(current.host_claimed_by || "") === String(currentUser.id || "") ? `<button class="primary-button" onclick="switchOpsView('host-event')">Manage My Event</button>` : `<button class="secondary-button" onclick="switchOpsView('host-event')">Open Hosting Schedule</button>`}</div>
    </div>` : `<div class="ix-empty"><strong>No live or claimed event is currently in progress.</strong><small>Head to Host an Event to claim an upcoming slot.</small><button class="primary-button" onclick="switchOpsView('host-event')">Host an Event</button></div>`;

    const upcomingHtml = upcomingHosted.length
        ? `<div class="ops-list">${upcomingHosted.map(e=>`<div class="ops-row"><div><b>${escapeHtml(e.title)}</b><small>${dashboardEventDateLabel(e)} · ${formatTime(e.start_time)} - ${formatTime(e.end_time)}</small></div><span class="ops-pill">${escapeHtml(e.host_claimed_name || "Claimed")}</span></div>`).join("")}</div>`
        : `<div class="ops-empty">No claimed hosting slots are coming up.</div>`;

    return `<div class="current-host-page">
        <section class="current-host-hero"><div><span class="host-eyebrow">INTERACTIONS CONTROL</span><h2>Current Host</h2><p>See who is hosting now, what is coming next, and jump straight into the hosting schedule.</p></div><button class="primary-button" onclick="switchOpsView('host-event')">🎲 Host an Event</button></section>
        ${liveHtml}
        ${ixPanel("Upcoming claimed hosting", upcomingHtml, `<span class="ix-panel-note">Next claimed slots</span>`)}
    </div>`;
}

function renderActionsDashboard(){
    const currentStaff = getCurrentStaffRecord();
    const myStaffId = currentStaff?.id ? String(currentStaff.id) : "";
    const assignments = (allEvents || []).filter(e => myStaffId && (e.event_staff || []).some(es => String(es.staff_id || "") === myStaffId)).sort((a,b) => String(a.event_date).localeCompare(String(b.event_date)) || String(a.start_time).localeCompare(String(b.start_time)));
    const upcoming = getUpcomingDashboardEvents(6);
    const actionsEvents = (allEvents || []).filter(e => !e.is_meeting && e.status !== "cancelled");
    const todayCount = actionsEvents.filter(e => e.event_date === formatDate(new Date())).length;
    const myCount = assignments.length;

    const assignmentHtml = assignments.length
        ? `<div class="ops-list">${assignments.slice(0,8).map(e=>`<div class="ops-row"><div><b>${escapeHtml(e.title)}</b><small>${dashboardEventDateLabel(e)} · ${formatTime(e.start_time)} - ${formatTime(e.end_time)}</small></div><span class="ops-pill">${escapeHtml(e.event_types?.name || "Event")}</span></div>`).join("")}</div>`
        : `<div class="ops-empty">No event assignments are currently attached to your staff profile.</div>`;

    const upcomingHtml = upcoming.length
        ? `<div class="ops-list">${upcoming.map(e=>`<div class="ops-row"><div><b>${escapeHtml(e.title)}</b><small>${dashboardEventDateLabel(e)} · ${formatTime(e.start_time)}</small></div><span class="ops-pill">${escapeHtml(e.event_types?.name || "Event")}</span></div>`).join("")}</div>`
        : `<div class="ops-empty">No upcoming events are scheduled.</div>`;

    return `<div class="actions-dashboard-page">
        <section class="actions-dashboard-hero"><div><span class="host-eyebrow">ACTIONS WORKSPACE</span><h2>Actions Dashboard</h2><p>Your side of KNG Entertainment, focused on event support, assignments, schedule awareness and team activity.</p></div><div class="actions-dashboard-badge">⚡ ACTIONS</div></section>
        <div class="ix-stat-row">
            <div class="ix-stat"><span>Events Today</span><strong>${todayCount}</strong><small>scheduled entertainment</small></div>
            <div class="ix-stat"><span>My Assignments</span><strong>${myCount}</strong><small>event allocations</small></div>
            <div class="ix-stat"><span>Upcoming</span><strong>${upcoming.length}</strong><small>next scheduled events</small></div>
            <div class="ix-stat"><span>Team</span><strong>ACTIONS</strong><small>your workspace</small></div>
        </div>
        <div class="ix-two-col">
            ${ixPanel("My Actions Assignments", assignmentHtml, `<span class="ix-panel-note">Your allocated events</span>`)}
            ${ixPanel("Upcoming Schedule", upcomingHtml, `<span class="ix-panel-note">Shared KNG calendar</span>`)}
        </div>
        ${ixPanel("Actions shortcuts", `<div class="ix-quick-grid"><button onclick="switchOpsView('action-schedule')">Action Schedule</button><button onclick="switchOpsView('host-action')">Host an Action</button><button onclick="switchOpsView('action-tracker')">Actions Tracker</button><button onclick="switchOpsView('event-suggestions')">Event Suggestions</button><button onclick="switchOpsView('staff-roster')">Staff Roster</button><button onclick="switchOpsView('command-dashboard')">Command Dashboard</button><button onclick="switchOpsView('personal-dashboard')">My Dashboard</button></div>`)}
    </div>`;
}

function renderDailyGoals(){ return renderPersonalDashboard(); }

function getRosterDisplayName(row) {
    const name = String(row?.display_name || row?.staff?.name || '').trim();
    if (name && !/^discord user$/i.test(name)) return name;
    const discord = String(row?.staff?.discord_id || row?.discord_id || '').trim();
    return discord || 'Discord user';
}

// These roles are management over BOTH Actions and Interactions. They are
// stored once in the roster, but are deliberately displayed at the top of
// both team rosters so the Discord copy is useful for either team. Directors
// remain outside the normal roster export/display.
function isCrossTeamManagementRole(level) {
    return ['manager', 'culture_manager', 'entertainment_resp'].includes(String(level || '').toLowerCase());
}

// Staff roster visibility is team-scoped for ADM and below. Only roles
// genuinely above ADM get the cross-team view: Entertainment Resp, Culture
// Manager, Manager and Director. The roster itself remains a single source
// of truth, so we do not need duplicate database rows for the same person.
function canViewRosterTeam(team) {
    const wanted = String(team || '').toLowerCase();
    if (!['actions', 'interactions'].includes(wanted)) return false;
    if (permissionRank() > permissionRank('adm') || isCrossTeamManager() || isDirector()) return true;
    return getCurrentEntertainmentTeam() === wanted;
}

function canPromoteRosterRow(row) {
    if (!row) return false;
    const selfDiscord = getDiscordIdentity().discordId;
    const rowDiscord = String(row.staff?.discord_id || row.discord_id || '').trim();
    if (selfDiscord && rowDiscord && selfDiscord === rowDiscord) return false;
    const level = String(row.hierarchy_level || 'member').toLowerCase();
    const me = getPermissionLevel();
    if (me === 'aux') return ['member','sub_ld','ld'].includes(level);
    if (!canManage()) return false;
    const next = { member:'sub_ld', sub_ld:'ld', ld:'aux', aux:'adm', adm:'entertainment_resp', entertainment_resp:'manager', culture_manager:'manager', manager:'director' }[level];
    if (!next) return false;
    if (isCrossTeamManager() && ['entertainment_resp','manager','culture_manager','director'].includes(next)) return false;
    const targetRank = permissionRank(next === 'sub_ld' || next === 'ld' ? 'member' : next);
    return permissionRank() > targetRank;
}

function rosterMemberHtml(r, team) {
    const selfDiscord = getDiscordIdentity().discordId;
    const rowDiscord = String(r.staff?.discord_id || r.discord_id || '').trim();
    const isSelf = Boolean(selfDiscord && rowDiscord && selfDiscord === rowDiscord);
    const controls = canManage() && !isSelf && isDirector() ? `<button class="mini-btn" onclick="openRosterAccessModal('${r.id}')">ACCESS</button>` : '';
    const actions = !isSelf && (canManage() || getPermissionLevel()==='aux')
        ? `${canPromoteRosterRow(r) ? `<button class="mini-btn" onclick="promoteRosterMember('${r.id}')">PROMOTE</button>` : ''}<button class="mini-btn" onclick="openRosterEditModal('${r.id}')">EDIT</button>${canManage() && isDirector() ? `<button class="mini-btn danger" onclick="deleteRosterMember('${r.id}')">REMOVE</button>` : ''}`
        : `<span class="roster-view-only">${isSelf ? 'Own account' : 'View only'}</span>`;
    return `<div class="roster-row">
        <span class="roster-name"><b>${escapeHtml(getRosterDisplayName(r))}</b>${(ixData.hof||[]).some(h=>String(h.winner_staff_id||'')===String(r.staff_id||'') || (r.staff?.discord_id && String(h.winner_discord_id||'')===String(r.staff.discord_id))) ? `<small class="roster-hof-link">🏆 Hall of Fame</small>` : ``}</span>
        <span>${escapeHtml(r.kng_id||'N/A')}</span>
        <span>${escapeHtml(r.staff?.discord_id||r.discord_id||'N/A')}</span>
        <span>${Number(r.strikes||0)}/3</span>
        <span>${r.mentor?'Yes':'N/A'}</span>
        <span class="roster-access"><span class="access-level-pill">${escapeHtml(rosterLevelLabel(r.hierarchy_level,team))}</span>${controls}</span>
        <span class="roster-actions">${actions}</span>
    </div>`;
}

function renderRosterGroup(level, members, team) {
    if (!members.length) return '';
    return `<div class="roster-group">
        <div class="roster-group-title">${escapeHtml(rosterLevelLabel(level,team))}</div>
        <div class="roster-table">
            <div class="roster-head"><span>NAME</span><span>ID</span><span>DISCORD</span><span>STRIKES</span><span>MENTOR</span><span>ACCESS</span><span>ACTIONS</span></div>
            ${members.map(r=>rosterMemberHtml(r,team)).join('')}
        </div>
    </div>`;
}

function renderAccessTeamDirectory() {
    const rows = (accessDirectory.length ? accessDirectory : (rosterData || []).map(r => ({
        staff_id: r.staff_id,
        name: getRosterDisplayName(r),
        discord_id: r.staff?.discord_id || r.discord_id || '',
        team: r.team,
        hierarchy_level: r.hierarchy_level,
        access_level: r.hierarchy_level,
        active: r.active
    })))
        .filter(r => r.active !== false)
        .sort((a,b) => rosterLevelRank(b.hierarchy_level)-rosterLevelRank(a.hierarchy_level) || String(a.team||'').localeCompare(String(b.team||'')) || String(a.name||'').localeCompare(String(b.name||'')));
    if (!rows.length) return '';
    return `<details class="roster-directory-panel roster-directory-dropdown"><summary class="roster-team-title-row"><div><div class="roster-team-title">ACCESS & TEAM DIRECTORY</div><small>Management view of who is allocated where and what site access they hold.</small></div><span class="directory-toggle">Show / hide <b>⌄</b></span></summary><div class="roster-directory-grid"><div class="roster-directory-row roster-directory-head"><strong>NAME</strong><span>TEAM</span><span>ROSTER ROLE</span><span>SITE ACCESS</span></div>${rows.map(r=>`<div class="roster-directory-row"><strong>${escapeHtml(r.name||'Discord user')}</strong><span>${escapeHtml(String(r.team||'').toUpperCase())}</span><span>${escapeHtml(rosterLevelLabel(r.hierarchy_level,r.team))}</span><span>${escapeHtml(String(r.access_level||'member').replaceAll('_',' ').toUpperCase())}</span></div>`).join('')}</div></details>`;
}

function renderStaffRoster(){
    if (!currentUser || permissionRank() < 1) return `<div class="ix-panel"><div class="ix-empty">Staff access required.</div></div>`;

    const canSeeBoth = permissionRank() > permissionRank('adm');
    const visibleTeams = canSeeBoth ? ['interactions', 'actions'] :
        (getCurrentEntertainmentTeam() ? [getCurrentEntertainmentTeam()] : []);

    if (!visibleTeams.length) {
        return `<div class="ix-panel"><div class="ix-empty">Your roster team has not been allocated yet.</div></div>`;
    }

    const managementRows=(rosterData || [])
        .filter(r=>canSeeBoth && r.active !== false && isCrossTeamManagementRole(r.hierarchy_level))
        .sort((a,b)=>rosterLevelRank(b.hierarchy_level)-rosterLevelRank(a.hierarchy_level)||getRosterDisplayName(a).localeCompare(getRosterDisplayName(b)));

    const renderManagement=()=> managementRows.length
        ? `<div class="roster-group roster-management-group">
            <div class="roster-group-title">MANAGEMENT · BOTH TEAMS</div>
            <div class="roster-management-note">Management staff are shown at the top of both Actions and Interactions.</div>
            <div class="roster-table">
                <div class="roster-head"><span>NAME</span><span>ID</span><span>DISCORD</span><span>STRIKES</span><span>MENTOR</span><span>ACCESS</span><span>ACTIONS</span></div>
                ${managementRows.map(r=>rosterMemberHtml(r, 'management')).join('')}
            </div>
        </div>`
        : '';

    const renderTeam=(team)=>{
        if (!canViewRosterTeam(team)) return '';
        // Management is rendered separately above, so team sections only show
        // the team-specific ADM/AUX/LD/SUB-LD/MEMBER rows.
        const rows=rosterData
            .filter(r=>r.team===team && r.active !== false && !isCrossTeamManagementRole(r.hierarchy_level) && String(r.hierarchy_level||'').toLowerCase() !== 'director')
            .sort((a,b)=>rosterLevelRank(b.hierarchy_level)-rosterLevelRank(a.hierarchy_level)||getRosterDisplayName(a).localeCompare(getRosterDisplayName(b)));
        const groups=['adm','aux','ld','sub_ld','member'];
        return groups.map(level=>renderRosterGroup(level, rows.filter(r=>String(r.hierarchy_level||'').toLowerCase()===level), team)).join('') || `<div class="ix-empty">No ${escapeHtml(team)} staff allocated yet.</div>`;
    };

    const exportButton=(team,label)=>canManage() && canViewRosterTeam(team) ? `<button class="primary-button small" onclick="copyRosterToDiscord('${team}')">${label} · Copy Discord Roster</button>` : '';
    const managementCount=managementRows.length;
    const directory = canSeeBoth ? renderAccessTeamDirectory() : '';

    const renderVisibleTeam=(team, label)=>{
        if (!canViewRosterTeam(team)) return '';
        const count = rosterData.filter(r=>r.team===team && r.active!==false && !String(r.hierarchy_level||'').toLowerCase().includes('director') && !isCrossTeamManagementRole(r.hierarchy_level)).length + managementCount;
        return `<section class="roster-team-panel">
            <div class="roster-team-title-row"><div><div class="roster-team-title">${label}</div><small>${count} members shown${managementCount ? ` · includes ${managementCount} management` : ''}</small></div>${exportButton(team,label)}</div>
            ${renderManagement()}
            ${renderTeam(team)}
        </section>`;
    };

    return `<div class="roster-page">${directory}${visibleTeams.map(team=>renderVisibleTeam(team, team.toUpperCase())).join('')}</div>`;
}

function bindInteractionHandlers(){ }

async function openAnnouncementModal(){
    if(!canManage()) return;
    showModal(`<div class="modal"><div class="modal-header"><div><span class="modal-eyebrow">Announcement</span><h2>New Announcement</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><form id="ixAnnForm" class="ops-form"><input name="title" placeholder="Title" required maxlength="120"><select name="category"><option>UPDATE</option><option>IMPORTANT</option><option>EVENT</option><option>STAFF</option></select><textarea name="body" placeholder="Announcement" required rows="6"></textarea><button class="primary-button">Publish</button></form></div>`);
    document.getElementById("ixAnnForm")?.addEventListener("submit",async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target).entries());const {error}=await supabaseClient.from("ix_announcements").insert({...d,created_by:currentUser.id});if(error)return alert(error.message);closeModal();await loadInteractionData();render();});
}

async function deleteAnnouncement(id){ if(!canManage()||!confirm("Delete this announcement?"))return;const {error}=await supabaseClient.from("ix_announcements").delete().eq("id",id);if(error)return alert(error.message);await loadInteractionData();render(); }
async function submitEventFeedback(eventId, form) {
    const data = Object.fromEntries(new FormData(form).entries());
    const rating = Number(data.rating || 5);
    const feedback = String(data.feedback || '').trim();
    const name = String(data.display_name || '').trim() || 'Anonymous';
    if (!feedback) return alert('Please enter some feedback.');
    const { error } = await supabaseClient.from('event_feedback').insert({
        event_id: eventId,
        display_name: name,
        rating: Math.max(1, Math.min(5, rating)),
        feedback
    });
    if (error) return alert(error.message);
    closeModal();
    await loadEvents();
    openEvent(eventId);
}

async function submitEventSuggestion(eventId, form) {
    const data = Object.fromEntries(new FormData(form).entries());
    const suggestion = String(data.suggestion || '').trim();
    const name = String(data.display_name || '').trim() || 'Anonymous';
    if (!suggestion) return alert('Please enter your suggestion.');
    const { error } = await supabaseClient.from('event_suggestions').insert({
        event_id: eventId || null,
        display_name: name,
        title: eventId ? `Suggestion for ${selectedEvent?.title || 'event'}` : 'Event suggestion',
        suggestion,
        status: 'new'
    });
    if (error) return alert(error.message);
    closeModal();
    alert('Thank you. Your suggestion has been submitted.');
}

function openEventFeedbackModal(eventId, mode='feedback') {
    const event = events.find(e => e.id === eventId);
    if (!event) return;
    const title = mode === 'suggestion' ? 'Suggest something' : 'Give event feedback';
    showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">${escapeHtml(event.title)}</span><h2>${title}</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><form class="ops-form" onsubmit="event.preventDefault();${mode === 'suggestion' ? `submitEventSuggestion('${event.id}', this)` : `submitEventFeedback('${event.id}', this)`}"><input name="display_name" maxlength=80 placeholder="Your name (optional)">${mode === 'suggestion' ? `<textarea name="suggestion" rows=6 maxlength=1500 placeholder="What would you change or add?" required></textarea>` : `<select name="rating"><option value=5>★★★★★ Excellent</option><option value=4>★★★★ Great</option><option value=3>★★★ Good</option><option value=2>★★ Needs work</option><option value=1>★ Poor</option></select><textarea name="feedback" rows=6 maxlength=1500 placeholder="Tell us what you thought..." required></textarea>`}<button class="primary-button">Submit</button></form></div>`);
}

async function openEventSuggestionForum() {
    ixView = 'event-suggestions';
    try { localStorage.setItem('kng.ixView', ixView); } catch (_) {}
    await loadInteractionData();
    render();
}

function openNewEventSuggestionModal(){
    showModal(`<div class="modal"><div class="modal-header"><div><span class="modal-eyebrow">KNG COMMUNITY FORUM</span><h2>Post an Event Idea</h2><small>Anyone can suggest an idea. Posting it does not schedule an event.</small></div><button class="modal-close" onclick="closeModal()">×</button></div><form id="forumSuggestionForm" class="ops-form"><label>Your name <span class="form-optional">optional</span><input name="display_name" maxlength="80" placeholder="Anonymous"></label><label>Idea title<input name="title" maxlength="120" placeholder="e.g. Police vs Gangs Olympics" required></label><label>Your idea<textarea name="suggestion" rows="7" maxlength="1500" placeholder="Tell the KNG team what the event could be, how it would work, or why the community would enjoy it." required></textarea></label><div class="forum-submit-note">Staff will review the forum and can mark ideas as reviewed, accepted or declined. Nothing is automatically added to the schedule.</div><button class="primary-button">Post Idea</button></form></div>`);
    document.getElementById('forumSuggestionForm')?.addEventListener('submit',submitForumSuggestion);
}

async function submitGeneralEventSubmission(e){
    e.preventDefault();
    const d=Object.fromEntries(new FormData(e.target).entries());
    if(d.end_time<=d.start_time)return alert('End time must be later than start time.');
    const {error}=await supabaseClient.from('kng_event_submissions').insert({submitted_by:currentUser.id,display_name:getKngDisplayName(),workspace:d.workspace,title:d.title.trim(),event_type:d.event_type,event_date:d.event_date,start_time:d.start_time,end_time:d.end_time,description:d.description||null,status:'pending'});
    if(error)return alert(error.message);
    closeModal(); await loadInteractionData(); render();
}

async function submitForumSuggestion(e) {
    e.preventDefault();
    const form = e.currentTarget || e.target;
    if (!(form instanceof HTMLFormElement)) {
        return alert('The suggestion form could not be read. Please refresh and try again.');
    }
    const data = Object.fromEntries(new FormData(form).entries());
    const title = String(data.title||'').trim();
    const suggestion = String(data.suggestion||'').trim();
    if (!title || !suggestion) return alert('Please add a title and your event idea.');
    if (containsBlockedSuggestionLanguage(title, suggestion, data.display_name)) {
        return alert('Your suggestion could not be posted because it contains prohibited language. Please remove it and try again.');
    }
    const displayName = String(data.display_name||'').trim() || (currentUser ? getKngDisplayName() : 'Anonymous');
    const payload = { event_id:null, display_name:displayName, title, suggestion, status:'new' };
    if (currentUser?.id) payload.created_by = currentUser.id;

    // Return the inserted row so the forum can display it immediately instead of
    // relying on a second request that can be affected by stale state/RLS issues.
    const { data: inserted, error } = await supabaseClient
        .from('event_suggestions')
        .insert(payload)
        .select('*')
        .single();
    if (error) {
        return alert(`Could not post the idea: ${error.message}`);
    }

    closeModal();

    // Put the newly-created idea straight into the current forum view.
    // Then refresh from Supabase so a page reload uses the database as source of truth.
    if (inserted) {
        const existing = Array.isArray(ixData.suggestions) ? ixData.suggestions : [];
        ixData.suggestions = [inserted, ...existing.filter(x => x.id !== inserted.id)];
    }
    render();

    await loadInteractionData();
    render();
}

async function setSuggestionStatus(id, status) {
    if (!canApproveEvents()) return alert('Only AUX+ can moderate event ideas.');
    if (!id || !['reviewed','accepted','declined'].includes(status)) return;
    const { error } = await supabaseClient.from('event_suggestions').update({ status }).eq('id', id);
    if (error) return alert(error.message);
    await loadInteractionData();
    render();
}

async function deleteSuggestion(id) {
    if (!canApproveEvents()) return alert('Only AUX+ can delete event ideas.');
    if (!id) return;
    if (!confirm('Delete this suggestion permanently? This cannot be undone.')) return;
    const { error } = await supabaseClient.from('event_suggestions').delete().eq('id', id);
    if (error) return alert(`Could not delete the suggestion: ${error.message}`);
    ixData.suggestions = (ixData.suggestions || []).filter(x => x.id !== id);
    render();
}

async function loadRosterData() {
    if (!currentUser) { rosterData = []; return; }

    const [{ data, error }, { data: approvedRequests }, directoryResult] = await Promise.all([
        supabaseClient
            .from('entertainment_roster')
            .select('*, staff(id,name,discord_id,active)')
            .eq('active', true)
            .order('team')
            .order('hierarchy_level'),
        supabaseClient
            .from('staff_access_requests')
            .select('discord_id,requested_name,status,created_at')
            .eq('status', 'approved')
            .order('created_at', { ascending: false })
            .limit(500),
        permissionRank() >= 4
            ? supabaseClient.rpc('get_kng_access_directory')
            : Promise.resolve({ data: [], error: null })
    ]);
    accessDirectory = directoryResult?.error ? [] : (directoryResult?.data || []);

    if (error) {
        console.error('Roster load failed:', error);
        rosterData = [];
        return;
    }

    const approvedNames = new Map();
    (approvedRequests || []).forEach(req => {
        const id = String(req.discord_id || '').trim();
        const name = String(req.requested_name || '').trim();
        if (id && name && !approvedNames.has(id)) approvedNames.set(id, name);
    });

    rosterData = (data || []).map(row => {
        const discordId = String(row.staff?.discord_id || row.discord_id || '').trim();
        const requestedName = approvedNames.get(discordId) || '';
        const staffName = String(row.staff?.name || '').trim();
        const displayName = String(row.display_name || '').trim() ||
            (staffName && !/^discord user$/i.test(staffName) ? staffName : '') ||
            requestedName ||
            staffName ||
            discordId ||
            'Discord user';
        return { ...row, display_name: displayName };
    });
    syncCurrentAccessFromRoster();
}


function syncCurrentAccessFromRoster(){
    if(!currentUser || !Array.isArray(rosterData)) return;
    const discordId=getDiscordIdentity().discordId;
    if(!discordId) return;
    const rr=rosterData.find(r=>String(r.staff?.discord_id||r.discord_id||'')===String(discordId)&&r.active!==false);
    if(!rr) return;
    const mapped={director:'director',manager:'manager',culture_manager:'culture_manager',entertainment_resp:'entertainment_resp',adm:'adm',aux:'aux',ld:'member',sub_ld:'member',member:'member'}[rr.hierarchy_level];
    if(!mapped) return;
    if(permissionRank(mapped)>permissionRank(currentAccess?.access_level||'public')) currentAccess={access_level:mapped,active:true,_rosterDerived:true};
}

function rosterLevelRank(level) {
    return ({ director: 7, manager: 6, culture_manager: 6, entertainment_resp: 5.5, adm: 5, aux: 4, ld: 3, sub_ld: 2, member: 1 }[level] || 1);
}

function rosterLevelLabel(level, team) {
    if (level === 'manager') return `Manager Of ${team === 'actions' ? 'Actions' : 'Interactions'}`;
    if (level === 'culture_manager') return 'Culture Manager';
    if (level === 'entertainment_resp') return 'Entertainment Resp';
    if (level === 'sub_ld') return 'Sub-LD';
    return String(level || 'member').toUpperCase();
}

async function allocateEntertainmentTeam(staffId, team) {
    if (!canManage()) return;
    if (!['actions','interactions'].includes(team)) return;
    const { error } = await supabaseClient.rpc('allocate_entertainment_staff', {
        p_staff_id: staffId,
        p_team: team
    });
    if (error) return alert(error.message);
    await loadStaff();
    await loadRosterData();
    render();
}

async function promoteRosterMember(id) {
    if (!canPromoteRosterRow(rosterData.find(r => String(r.id) === String(id)))) return;
    const row = rosterData.find(r => String(r.id) === String(id));
    if (!row) return;
    const order = ['member','sub_ld','ld','aux','adm','entertainment_resp','manager','director'];
    const currentIndex = order.indexOf(row.hierarchy_level);
    let next = order[Math.min(currentIndex + 1, order.length - 1)];
    if (getPermissionLevel() === 'aux') next = 'aux';
    if (isCrossTeamManager() && ['entertainment_resp','manager','culture_manager','director'].includes(next)) return alert('You cannot promote staff into management or Director roles.');
    if (!next || next === row.hierarchy_level) return alert('They are already at the highest level.');
    const { error } = await supabaseClient.rpc('update_entertainment_roster_member', {
        p_roster_id: id,
        p_name: getRosterDisplayName(row),
        p_discord_id: String(row.staff?.discord_id || row.discord_id || '').trim(),
        p_team: row.team,
        p_hierarchy_level: next,
        p_kng_id: String(row.kng_id || '').trim(),
        p_strikes: Number(row.strikes || 0),
        p_mentor: !!row.mentor,
        p_notes: String(row.notes || '').trim()
    });
    if (error) return alert(error.message);
    await loadAccess();
    await loadRosterData();
    render();
}

async function deleteRosterMember(id) {
    if (!canManage() || !confirm('Remove this staff member from the Entertainment roster?')) return;
    const { error } = await supabaseClient.from('entertainment_roster').update({ active: false, updated_by: currentUser.id }).eq('id', id);
    if (error) return alert(error.message);
    await loadRosterData(); render();
}


async function openRosterAccessModal(id) {
    if (!canManage()) return;
    const row = rosterData.find(r => String(r.id) === String(id));
    if (!row) return;
    const { data, error } = await supabaseClient.rpc('get_entertainment_staff_access', { p_roster_id: id });
    if (error) return alert(error.message);
    const current = String(data || 'member').toLowerCase();
    const options = availableGrantLevels().map(([value, label]) => `<option value="${escapeAttribute(value)}" ${current===value?'selected':''}>${escapeHtml(label)}</option>`).join('');
    const currentLabel = current === 'manager' ? 'Management' : current === 'culture_manager' ? 'CULTURE MANAGER' : current === 'entertainment_resp' ? 'ENTERTAINMENT RESP' : current.toUpperCase();
    showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">KNG ACCESS</span><h2>${escapeHtml(getRosterDisplayName(row))}</h2><small>Set their site access separately from their team title.</small></div><button class="modal-close" onclick="closeModal()">×</button></div><div class="access-management-summary"><div><span>Current access</span><strong>${escapeHtml(currentLabel)}</strong></div><div><span>Team role</span><strong>${escapeHtml(rosterLevelLabel(row.hierarchy_level,row.team))}</strong></div></div><form id="rosterAccessForm" class="ops-form"><label>New access level<select name="access_level" required>${availableGrantLevels().map(([value,label]) => `<option value="${escapeAttribute(value)}" ${current===value?'selected':''}>${escapeHtml(label)}</option>`).join('')}</select></label><small>ADM → AUX · Management → ADM · Director → any access level.</small><button class="primary-button">Save Access</button></form></div>`);
    document.getElementById('rosterAccessForm')?.addEventListener('submit', async e => {
        e.preventDefault();
        const level = String(new FormData(e.target).get('access_level') || 'member');
        const { error } = await supabaseClient.rpc('set_entertainment_staff_access', { p_roster_id: id, p_access_level: level });
        if (error) return alert(error.message);
        closeModal();
        await loadAccess();
        await loadRosterData();
        render();
    });
}

function openRosterEditModal(id) {
    if (!canManage() && getPermissionLevel() !== 'aux') return;
    const row = rosterData.find(r => r.id === id);
    if (!row) return;
    const name = getRosterDisplayName(row);
    const discordId = row.staff?.discord_id || row.discord_id || '';
    const auxOnly = getPermissionLevel() === 'aux';
    showModal(`<div class="modal roster-edit-modal"><div class="modal-header"><div><span class="modal-eyebrow">KNG Entertainment</span><h2>Edit roster member</h2><small>${auxOnly ? 'AUX can update display names only.' : 'Change their roster name, team or level here.'}</small></div><button class="modal-close" onclick="closeModal()">×</button></div><form class="ops-form" id="rosterEditForm"><div class="form-grid"><div class="form-field"><label>Name</label><input name="name" value="${escapeAttribute(name)}" required></div>${auxOnly ? '' : `<div class="form-field"><label>ID</label><input name="kng_id" value="${escapeAttribute(row.kng_id || '')}"></div><div class="form-field"><label>Discord ID</label><input name="discord_id" value="${escapeAttribute(discordId)}"></div><div class="form-field"><label>Team</label><select name="team"><option value="actions" ${row.team==='actions'?'selected':''}>Actions</option><option value="interactions" ${row.team==='interactions'?'selected':''}>Interactions</option></select></div><div class="form-field"><label>Level</label><select name="hierarchy_level">${['director','manager','culture_manager','entertainment_resp','adm','aux','ld','sub_ld','member'].map(v=>`<option value="${v}" ${row.hierarchy_level===v?'selected':''}>${escapeHtml(rosterLevelLabel(v,row.team))}</option>`).join('')}</select></div><div class="form-field"><label>Strikes</label><select name="strikes"><option value="0" ${Number(row.strikes||0)===0?'selected':''}>0</option><option value="1" ${Number(row.strikes||0)===1?'selected':''}>1</option><option value="2" ${Number(row.strikes||0)===2?'selected':''}>2</option><option value="3" ${Number(row.strikes||0)>=3?'selected':''}>3</option></select></div><div class="form-field"><label>Mentor</label><select name="mentor"><option value="false" ${!row.mentor?'selected':''}>N/A</option><option value="true" ${row.mentor?'selected':''}>Mentor</option></select></div><div class="form-field full"><label>Notes</label><textarea name="notes" rows="4">${escapeHtml(row.notes || '')}</textarea></div>`}</div><button class="primary-button">Save Changes</button></form></div>`);
    document.getElementById('rosterEditForm')?.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target).entries());
        if (getPermissionLevel() === 'aux') { data.discord_id = String(row.staff?.discord_id || row.discord_id || ''); data.team = row.team; data.hierarchy_level = row.hierarchy_level; data.kng_id = row.kng_id || ''; data.strikes = row.strikes || 0; data.mentor = row.mentor ? 'true' : 'false'; data.notes = row.notes || ''; }
        const { error } = await supabaseClient.rpc('update_entertainment_roster_member', {
            p_roster_id: id,
            p_name: String(data.name || '').trim(),
            p_discord_id: String(data.discord_id || '').trim(),
            p_team: data.team,
            p_hierarchy_level: data.hierarchy_level,
            p_kng_id: String(data.kng_id || '').trim(),
            p_strikes: Number(data.strikes || 0),
            p_mentor: data.mentor === 'true',
            p_notes: String(data.notes || '').trim()
        });
        if (error) return alert(error.message);
        closeModal();
        await loadStaff();
        await loadRosterData();
        render();
    });
}

function buildDiscordRosterText(team) {
    const wanted = String(team || '').toLowerCase();
    const title = wanted === 'interactions' ? 'INTERACTIONS' : 'ACTIONS';
    const exportLevels = new Set(['adm','aux','ld','sub_ld','member']);

    // Management is cross-team: include the same management block at the top
    // of BOTH exports, regardless of which team their single roster row uses.
    const managementRows = (rosterData || [])
        .filter(r => r.active !== false && isCrossTeamManagementRole(r.hierarchy_level))
        .sort((a,b) => rosterLevelRank(b.hierarchy_level) - rosterLevelRank(a.hierarchy_level) || getRosterDisplayName(a).localeCompare(getRosterDisplayName(b)));

    const teamRows = (rosterData || [])
        .filter(r =>
            String(r.team || '').toLowerCase() === wanted &&
            r.active !== false &&
            exportLevels.has(String(r.hierarchy_level || '').toLowerCase())
        )
        .sort((a,b) => rosterLevelRank(b.hierarchy_level) - rosterLevelRank(a.hierarchy_level) || getRosterDisplayName(a).localeCompare(getRosterDisplayName(b)));

    const lines = [title, ''];

    if (managementRows.length) {
        lines.push('MANAGEMENT');
        managementRows.forEach(r => {
            const discordId = String(r.staff?.discord_id || r.discord_id || '').trim();
            if (discordId) lines.push(`• <@${discordId}>`);
        });
        lines.push('');
    }

    if (!teamRows.length) {
        lines.push('No team-specific staff currently allocated.');
        return lines.join('\n');
    }

    const groups = {};
    teamRows.forEach(r => {
        const level = rosterLevelLabel(r.hierarchy_level, wanted);
        (groups[level] ||= []).push(r);
    });

    Object.entries(groups).forEach(([level, members], index) => {
        if (index > 0 || managementRows.length) lines.push('');
        lines.push(level);
        members.forEach(r => {
            const discordId = String(r.staff?.discord_id || r.discord_id || '').trim();
            if (discordId) lines.push(`• <@${discordId}>`);
        });
    });

    return lines.join('\n');
}

async function copyRosterToDiscord(team) {
    if (!canManage()) return;
    if (!canViewRosterTeam(team)) return alert('You can only copy the roster for your assigned team.');
    const text = buildDiscordRosterText(team);
    try {
        await navigator.clipboard.writeText(text);
        const label = String(team || '').toLowerCase() === 'interactions' ? 'Interactions' : 'Actions';
        alert(`${label} Discord roster copied to clipboard.`);
    } catch (err) {
        showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">Discord Roster</span><h2>Copy blocked by browser</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><p class="modal-message">Your browser blocked clipboard access. The roster is below so you can copy it manually.</p><textarea class="roster-export-text" readonly rows="14">${escapeHtml(text)}</textarea><div class="modal-footer"><button class="primary-button" onclick="closeModal()">Close</button></div></div>`);
    }
}

function openRosterExportModal() {
    if(!canManage()) return;
    const teams = ['interactions','actions'].filter(canViewRosterTeam);
    const blocks = teams.map(team => {
        const label = team === 'interactions' ? 'INTERACTIONS' : 'ACTIONS';
        const text = buildDiscordRosterText(team);
        return `<div><h3>${label}</h3><textarea class="roster-export-text" readonly>${escapeHtml(text)}</textarea><button class="primary-button" onclick="copyRosterToDiscord('${team}')">Copy ${label}</button></div>`;
    }).join('');
    showModal(`<div class="modal roster-export-modal"><div class="modal-header"><div><span class="modal-eyebrow">KNG Entertainment</span><h2>Discord Roster Exports</h2><small>Only rosters you are permitted to view are shown.</small></div><button class="modal-close" onclick="closeModal()">×</button></div><div class="roster-export-grid">${blocks}</div></div>`);
}

async function copyRosterOutput(){ const text=document.getElementById('rosterExportText')?.value||''; try{await navigator.clipboard.writeText(text);alert('Hierarchy output copied.');}catch(_){alert(text);} }

async function moderateSuggestion(id) {
    return setSuggestionStatus(id, 'reviewed');
}

async function saveDailyGoal() {
    if (!isDirector()) return alert('Only a Director can change the daily target.');
    const target = prompt('Daily point target', '8');
    const n = Number(target);
    if (!Number.isFinite(n) || n < 1) return;
    const today = formatDate(new Date());
    const { error } = await supabaseClient.from('ix_daily_goals').upsert({ user_id: currentUser.id, goal_date: today, target_points: Math.floor(n), points_earned: 0 }, { onConflict: 'user_id,goal_date' });
    if (error) {
        if(String(error.message||'').toLowerCase().includes('schema cache') || String(error.message||'').toLowerCase().includes('does not exist')) {
            return showModal(`<div class="modal small-modal"><div class="modal-header"><div><span class="modal-eyebrow">Daily Goals</span><h2>Database setup required</h2></div><button class="modal-close" onclick="closeModal()">×</button></div><p class="modal-message">The Daily Goals table is not installed yet. Run <b>KNG-ENTERTAINMENT-COMPLETE-MIGRATION.sql</b> in Supabase, then refresh the site.</p><div class="modal-footer"><button class="primary-button" onclick="closeModal()">Close</button></div></div>`);
        }
        return alert(error.message);
    }
    await loadInteractionData(); render();
}

window.openEventFeedbackModal=openEventFeedbackModal;
window.submitEventFeedback=submitEventFeedback;
window.submitEventSuggestion=submitEventSuggestion;
window.openNewEventSuggestionModal=openNewEventSuggestionModal;
window.submitForumSuggestion=submitForumSuggestion;
window.submitGeneralEventSubmission=submitGeneralEventSubmission;
window.submitActionEvent=submitActionEvent;
window.openApproveEventSubmission=openApproveEventSubmission;
window.declineEventSubmission=declineEventSubmission;
window.openActionTrackerModal=openActionTrackerModal;
window.editActionTrackerRow=editActionTrackerRow;
window.openBrTrackerModal=openBrTrackerModal;
window.editBrTrackerRow=editBrTrackerRow;
window.openActionGoalModal=openActionGoalModal;
window.moderateSuggestion=moderateSuggestion;
window.setSuggestionStatus=setSuggestionStatus;
window.deleteSuggestion=deleteSuggestion;
window.allocateEntertainmentTeam=allocateEntertainmentTeam;
window.promoteRosterMember=promoteRosterMember;
window.openRosterEditModal=openRosterEditModal;
window.deleteRosterMember=deleteRosterMember;
window.openRosterExportModal=openRosterExportModal;
window.copyRosterOutput=copyRosterOutput;
window.copyRosterToDiscord=copyRosterToDiscord;
window.openPostApprovalAllocationModal=openPostApprovalAllocationModal;
window.finishPostApprovalAllocation=finishPostApprovalAllocation;
window.saveDailyGoal=saveDailyGoal;
window.searchDirectorStaffDirectory=searchDirectorStaffDirectory;
window.setDirectorStaffAccess=setDirectorStaffAccess;

/* =========================================================
   START
   ========================================================= */

init();
new MutationObserver(()=>{ if(document.getElementById("hofPhotoWindow")) bindHofPhotoControls(); }).observe(document.body,{childList:true,subtree:true});