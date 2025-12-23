/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 portgee
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { ModalContent, ModalHeader, ModalRoot, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import {
    FluxDispatcher,
    GuildMemberStore,
    Menu,
    React,
    RestAPI,
    SelectedChannelStore,
    SelectedGuildStore,
    Text,
    useEffect,
    useMemo,
    useRef,
    UserProfileActions,
    UserStore,
    UserUtils,
    useState
} from "@webpack/common";

const settings = definePluginSettings({
    maxMembersToScan: {
        type: OptionType.NUMBER,
        description: "Maximum members to scan per run (0 = none)",
        default: 250
    },
    concurrency: {
        type: OptionType.NUMBER,
        description: "How many profile requests to run at once (requests are globally rate-limited)",
        default: 2
    },
    includeBots: {
        type: OptionType.BOOLEAN,
        description: "Include bots",
        default: false
    },
    requestDelayMs: {
        type: OptionType.NUMBER,
        description: "Global delay between profile requests (ms). Higher = fewer 429s.",
        default: 1200
    },
    maxPauseMs: {
        type: OptionType.NUMBER,
        description: "Max pause duration when rate-limited (ms)",
        default: 60000
    },

    persistCache: {
        type: OptionType.BOOLEAN,
        description: "Persist mutual cache across Discord reloads",
        default: true
    },
    persistMaxAgeDays: {
        type: OptionType.NUMBER,
        description: "Discard cached entries older than this many days (0 = never)",
        default: 14
    },
    persistMaxEntriesPerGuild: {
        type: OptionType.NUMBER,
        description: "Max cached user entries per guild (oldest are dropped; 0 = unlimited)",
        default: 2000
    }
});

type MutualFriend = {
    id: string;
    username?: string;
    global_name?: string;
    globalName?: string;
};

type PersistEntry = {
    mutuals: MutualFriend[];
    updatedAt: number; // epoch ms
};

type PersistGuild = Record<string, PersistEntry>; // userId -> entry

type PersistRoot = {
    v: number;
    guilds: Record<string, PersistGuild>; // guildId -> PersistGuild
};

const PERSIST_KEY = "GuildMutualFriends:cache";
const PERSIST_VERSION = 1;

function safeLower(s: any) {
    return (typeof s === "string" ? s : "").toLowerCase();
}

function getGuildIdFromProps(props: any): string | null {
    return props?.guild?.id ?? props?.guildId ?? props?.id ?? null;
}

function getGuildNameFromProps(props: any): string | undefined {
    return props?.guild?.name ?? props?.name;
}

const mutualCache = new Map<string, Map<string, MutualFriend[]>>();
const mutualMeta = new Map<string, Map<string, number>>();

function getCache(guildId: string): Map<string, MutualFriend[]> {
    let g = mutualCache.get(guildId);
    if (!g) {
        g = new Map();
        mutualCache.set(guildId, g);
    }
    return g;
}

function getMeta(guildId: string): Map<string, number> {
    let g = mutualMeta.get(guildId);
    if (!g) {
        g = new Map();
        mutualMeta.set(guildId, g);
    }
    return g;
}

function getDisplayName(guildId: string, userId: string) {
    const user = UserStore.getUser(userId);
    const member = GuildMemberStore?.getMember?.(guildId, userId);

    const username = user?.username ?? "Unknown";
    const globalName = (user as any)?.globalName ?? (user as any)?.global_name;
    const nick = member?.nick;
    const display = nick || globalName || username;
    const isBot = Boolean((user as any)?.bot);

    return { display, username, isBot };
}

async function openUserProfile(userId: string) {
    if (!userId) return;

    try {
        await (UserUtils as any)?.getUser?.(userId);
    } catch (e: any) {
        try {
            await RestAPI.get({ url: `/users/${userId}`, retries: 0 });
        } catch { }
    }

    const guildId = SelectedGuildStore?.getGuildId?.() ?? null;
    const channelId = SelectedChannelStore?.getChannelId?.() ?? null;

    try {
        if (UserProfileActions?.openUserProfileModal) {
            UserProfileActions.openUserProfileModal({
                userId,
                guildId,
                channelId,
                analyticsLocation: {
                    page: guildId ? "Guild Channel" : "DM Channel",
                    section: "Profile Popout"
                }
            });
            return;
        }

        const u: any = UserUtils as any;

        if (u?.openUserProfileModal) {
            u.openUserProfileModal({ userId, guildId, channelId });
            return;
        }

        if (u?.openUserProfile) {
            u.openUserProfile(userId, channelId, guildId);
            return;
        }

        FluxDispatcher.dispatch({
            type: "USER_PROFILE_MODAL_OPEN",
            userId,
            guildId,
            channelId
        });
    } catch (e) {
        console.error("[GuildMutualFriends] Failed to open user profile:", e);
    }
}

function getGuildMemberIds(guildId: string): string[] {
    if (!guildId || !GuildMemberStore) return [];

    try {
        const members = GuildMemberStore.getMembers?.(guildId);

        if (members instanceof Map) {
            return Array.from(members.keys())
                .map(id => String(id))
                .filter((id): id is string => typeof id === "string" && id.length > 0);
        }

        if (Array.isArray(members)) {
            return members
                .map((m: any) => m?.userId ?? m?.user?.id ?? m?.id)
                .filter((id: any): id is string => typeof id === "string" && id.length > 0);
        }

        if (typeof members === "object" && members !== null) {
            return Object.keys(members).filter(id => typeof id === "string" && id.length > 0);
        }

        const memberIds = GuildMemberStore.getMemberIds?.(guildId);
        if (Array.isArray(memberIds)) {
            return memberIds.filter((id: any): id is string => typeof id === "string" && id.length > 0);
        }
    } catch (e) {
        console.error("[GuildMutualFriends] Error getting member IDs:", e);
    }

    return [];
}

async function requestMembers(guildId: string): Promise<void> {
    return new Promise(resolve => {
        try {
            FluxDispatcher.dispatch({
                type: "GUILD_MEMBERS_REQUEST",
                guildIds: [guildId],
                query: "",
                limit: 0
            });
        } catch (e) {
            console.warn("[GuildMutualFriends] GUILD_MEMBERS_REQUEST dispatch failed:", e);
        }
        setTimeout(resolve, 1000);
    });
}

function parseNum(v: any): number | null {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim().length) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function getRetryAfterMs(err: any): number | null {
    const body = err?.body ?? err?.response?.body ?? err?.res?.body;
    const raBody =
        body?.retry_after ??
        body?.retryAfter ??
        err?.retry_after ??
        err?.retryAfter;

    const raNum = parseNum(raBody);
    if (raNum != null) {
        return raNum < 1000 ? Math.ceil(raNum * 1000) : Math.ceil(raNum);
    }

    const headers = err?.headers ?? err?.response?.headers ?? err?.res?.headers;
    const raHeader =
        headers?.["retry-after"] ??
        headers?.["Retry-After"] ??
        headers?.retry_after ??
        headers?.retryAfter;

    const raH = parseNum(raHeader);
    if (raH != null) {
        return raH < 1000 ? Math.ceil(raH * 1000) : Math.ceil(raH);
    }

    const resetAfter =
        headers?.["x-ratelimit-reset-after"] ??
        headers?.["X-RateLimit-Reset-After"] ??
        headers?.["x-ratelimit-reset_after"] ??
        headers?.["X-RateLimit-Reset_After"];

    const raReset = parseNum(resetAfter);
    if (raReset != null) {
        return raReset < 1000 ? Math.ceil(raReset * 1000) : Math.ceil(raReset);
    }

    const status = err?.status ?? err?.response?.status ?? err?.res?.status;
    if (status === 429) return 2000;

    const msg = String(err?.message ?? err ?? "");
    if (msg.toLowerCase().includes("too many") || (msg.toLowerCase().includes("rate") && msg.toLowerCase().includes("limit")))
        return 2000;

    return null;
}

async function sleep(ms: number) {
    await new Promise(r => setTimeout(r, ms));
}

class GlobalRateLimiter {
    private nextAt = 0;
    private pauseUntil = 0;
    private gate: Promise<void> = Promise.resolve();

    public setPausedUntil(until: number) {
        this.pauseUntil = Math.max(this.pauseUntil, until);
    }

    public getPausedUntil() {
        return this.pauseUntil > Date.now() ? this.pauseUntil : null;
    }

    public async acquire(intervalMs: number) {
        const run = async () => {
            const now = Date.now();

            const p = this.pauseUntil;
            if (p > now) {
                await sleep(p - now);
            }

            const now2 = Date.now();
            const wait = Math.max(0, this.nextAt - now2);
            if (wait > 0) await sleep(wait);

            const now3 = Date.now();
            this.nextAt = now3 + Math.max(0, intervalMs);
        };

        const prev = this.gate;
        let release!: () => void;
        this.gate = new Promise<void>(r => (release = r));
        await prev;

        try {
            await run();
        } finally {
            release();
        }
    }
}

/**
 * CHANGE #1 (required):
 * - Treat Discord's "Unknown User" (code 10013 / status 404) as a normal skip and return []
 * - Works whether RestAPI.get returns { ok:false, status:404, body:{code:10013} } OR throws that object
 */
async function fetchMutualFriends(userId: string): Promise<MutualFriend[]> {
    if (!userId) return [];

    try {
        const res = await RestAPI.get({
            url: `/users/${userId}/profile`,
            query: {
                with_mutual_friends: true,
                with_mutual_guilds: false
            },
            retries: 0
        });

        // Some implementations return ok/status rather than throwing
        const ok = (res as any)?.ok;
        const status = (res as any)?.status;
        const code = (res as any)?.body?.code;

        if (ok === false || status === 404 || code === 10013) {
            return [];
        }

        const body = (res as any)?.body;

        const mutuals =
            body?.mutual_friends ??
            body?.user_profile?.mutual_friends ??
            body?.mutualFriends ??
            [];

        const count =
            body?.mutual_friends_count ??
            body?.user_profile?.mutual_friends_count ??
            body?.mutualFriendsCount;

        if ((!Array.isArray(mutuals) || mutuals.length === 0) && typeof count === "number" && count > 0) {
            return [{
                id: "count-only",
                username: `(Mutuals exist, but Discord returned count only: ${count})`
            }];
        }

        return Array.isArray(mutuals) ? mutuals : [];
    } catch (e: any) {
        const status = e?.status ?? e?.response?.status ?? e?.res?.status;
        const code =
            e?.body?.code ??
            e?.response?.body?.code ??
            e?.res?.body?.code;

        if (status === 404 || code === 10013) return [];

        throw e;
    }
}

type Row = {
    userId: string;
    display: string;
    username: string;
    mutuals: MutualFriend[];
};

function openMutualModal(guildId: string, guildName?: string) {
    if (!guildId) return;

    openModal((modalProps: any) => (
        <ModalRoot {...modalProps} size="medium">
            <MutualFriendsModal
                guildId={guildId}
                guildName={guildName}
                onClose={modalProps.onClose}
            />
        </ModalRoot>
    ));
}

function MiniButton(props: {
    disabled?: boolean;
    onClick?: (e: React.MouseEvent) => void;
    children: React.ReactNode;
}) {
    const { disabled, onClick, children } = props;

    return (
        <button
            type="button"
            disabled={disabled}
            onMouseDown={e => {
                e.preventDefault();
                e.stopPropagation();
                (e as any).nativeEvent?.stopImmediatePropagation?.();
            }}
            onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                (e as any).nativeEvent?.stopImmediatePropagation?.();
                onClick?.(e);
            }}
            style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--background-tertiary)",
                background: disabled ? "var(--background-tertiary)" : "var(--background-secondary)",
                color: "var(--text-normal)",
                cursor: disabled ? "not-allowed" : "pointer",
                transition: "filter 120ms ease, opacity 120ms ease",
                opacity: disabled ? 0.65 : 1
            }}
            onMouseEnter={e => {
                if (disabled) return;
                (e.currentTarget as HTMLButtonElement).style.filter = "brightness(0.92)";
            }}
            onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.filter = "";
            }}
        >
            <Text variant="text-sm/semibold">{children as any}</Text>
        </button>
    );
}

function MentionChip(props: {
    userId: string;
    label: string;
    onStopAll: (e: any) => void;
}) {
    const { userId, label, onStopAll } = props;

    return (
        <span
            role="button"
            tabIndex={0}
            onPointerDown={onStopAll}
            onMouseDown={onStopAll}
            onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                (e as any).nativeEvent?.stopImmediatePropagation?.();
                openUserProfile(userId);
            }}
            onKeyDown={e => {
                if ((e as any).key === "Enter" || (e as any).key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    (e as any).nativeEvent?.stopImmediatePropagation?.();
                    openUserProfile(userId);
                }
            }}
            style={{
                display: "inline-block",
                padding: "1px 6px",
                borderRadius: 4,
                cursor: "pointer",
                userSelect: "none",
                color: "var(--mention-foreground)",
                background: "var(--mention-background)",
                marginRight: 4
            }}
            title={`Open profile: ${label}`}
        >
            @{label}
        </span>
    );
}

function isValidMutualArray(x: any): x is MutualFriend[] {
    return Array.isArray(x) && x.every(m => m && typeof m.id === "string");
}

function normalizePersistRoot(x: any) {
    if (!x || typeof x !== "object") {
        return { v: PERSIST_VERSION, guilds: {} } as PersistRoot;
    }
    if ((x as any).v !== PERSIST_VERSION || !(x as any).guilds || typeof (x as any).guilds !== "object") {
        return { v: PERSIST_VERSION, guilds: {} } as PersistRoot;
    }
    return x as PersistRoot;
}

async function loadPersistentIntoMemory() {
    if (!settings.store.persistCache) return;

    try {
        const raw = await DataStore.get(PERSIST_KEY);
        const root = normalizePersistRoot(raw);

        const now = Date.now();
        const maxAgeDays = Math.max(0, settings.store.persistMaxAgeDays);
        const maxAgeMs = maxAgeDays === 0 ? 0 : maxAgeDays * 24 * 60 * 60 * 1000;

        for (const [guildId, guild] of Object.entries(root.guilds)) {
            if (!guildId || !guild || typeof guild !== "object") continue;

            const gCache = getCache(guildId);
            const gMeta = getMeta(guildId);

            for (const [userId, entry] of Object.entries(guild)) {
                const mutuals = (entry as any)?.mutuals;
                const updatedAt = Number((entry as any)?.updatedAt ?? 0);

                if (!userId) continue;
                if (!isValidMutualArray(mutuals)) continue;

                if (maxAgeMs > 0 && updatedAt > 0 && now - updatedAt > maxAgeMs) {
                    continue;
                }

                gCache.set(userId, mutuals);
                gMeta.set(userId, updatedAt || now);
            }
        }
    } catch (e) {
        console.warn("[GuildMutualFriends] Failed to load persistent cache:", e);
    }
}

function pruneGuildPersistEntries(guild: PersistGuild) {
    const maxEntries = Math.max(0, settings.store.persistMaxEntriesPerGuild);
    if (maxEntries === 0) return guild;

    const entries = Object.entries(guild);
    if (entries.length <= maxEntries) return guild;

    entries.sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0));
    const toDrop = entries.length - maxEntries;

    for (let i = 0; i < toDrop; i++) {
        delete guild[entries[i][0]];
    }
    return guild;
}

async function writeThroughPersist(guildId: string, userId: string, mutuals: MutualFriend[], updatedAt: number) {
    if (!settings.store.persistCache) return;

    try {
        const raw = await DataStore.get(PERSIST_KEY);
        const root = normalizePersistRoot(raw);

        if (!root.guilds[guildId]) root.guilds[guildId] = {};
        root.guilds[guildId][userId] = { mutuals, updatedAt };

        pruneGuildPersistEntries(root.guilds[guildId]);

        await DataStore.set(PERSIST_KEY, root);
    } catch (e) {
        console.warn("[GuildMutualFriends] Failed to persist cache entry:", e);
    }
}

async function clearPersistentAll() {
    try {
        await DataStore.set(PERSIST_KEY, { v: PERSIST_VERSION, guilds: {} } satisfies PersistRoot);
    } catch (e) {
        console.warn("[GuildMutualFriends] Failed to clear persistent cache:", e);
    }
}

const MutualFriendsModal = ErrorBoundary.wrap(
    ({ guildId, guildName, onClose }: any) => {
        const [query, setQuery] = useState("");
        const [status, setStatus] = useState<"idle" | "running" | "done" | "stopped" | "error" | "paused">("idle");
        const [progress, setProgress] = useState({ done: 0, total: 0 });
        const [rows, setRows] = useState<Row[]>([]);
        const [errorText, setErrorText] = useState<string | null>(null);
        const [debugInfo, setDebugInfo] = useState<string>("");
        const [pausedUntil, setPausedUntil] = useState<number | null>(null);

        const [nowTick, setNowTick] = useState<number>(() => Date.now());

        const stopRef = useRef(false);
        const runIdRef = useRef(0);

        const limiterRef = useRef<GlobalRateLimiter | null>(null);

        function stopAll(e: any) {
            try { e?.stopPropagation?.(); } catch { }
        }

        function cancel() {
            stopRef.current = true;
            setPausedUntil(null);
            setStatus(s => (s === "running" || s === "paused" ? "stopped" : s));
        }

        function loadCachedRowsNow() {
            if (!guildId) return;

            const cache = getCache(guildId);
            const out: Row[] = [];

            for (const [userId, mutuals] of cache.entries()) {
                if (!mutuals || mutuals.length === 0) continue;

                const { display, username, isBot } = getDisplayName(guildId, userId);
                if (!settings.store.includeBots && isBot) continue;

                out.push({ userId, display, username, mutuals });
            }

            out.sort((a, b) => safeLower(a.display).localeCompare(safeLower(b.display)));

            if (out.length > 0) setRows(out);
            setDebugInfo(prev => prev || `Loaded ${out.length} cached result(s)`);
        }

        async function runScan() {
            const myRunId = ++runIdRef.current;
            stopRef.current = false;

            limiterRef.current = new GlobalRateLimiter();

            setErrorText(null);
            setStatus("running");
            setDebugInfo("");
            setPausedUntil(null);

            if (!guildId) {
                setErrorText("No guild id.");
                setStatus("error");
                return;
            }

            loadCachedRowsNow();

            setDebugInfo("Requesting member list from Discord...");
            await requestMembers(guildId);
            if (runIdRef.current !== myRunId || stopRef.current) return;

            const allIds = getGuildMemberIds(guildId);
            setDebugInfo(`Found ${allIds.length} members in cache`);

            if (allIds.length === 0) {
                setErrorText(
                    "No members found in cache. Open the member list sidebar for this server and scroll a bit, then rescan."
                );
                setStatus("error");
                return;
            }

            const max = Math.max(0, settings.store.maxMembersToScan);
            const cache = getCache(guildId);
            const meta = getMeta(guildId);

            const scanBase = max === 0 ? allIds : allIds.slice(0, max);

            const scanIds: string[] = [];
            const selfId = UserStore.getCurrentUser?.()?.id;

            for (const id of scanBase) {
                if (!id) continue;
                if (selfId && id === selfId) continue;

                const { isBot } = getDisplayName(guildId, id);
                if (!settings.store.includeBots && isBot) continue;

                scanIds.push(id);
            }

            setProgress({ done: 0, total: scanIds.length });
            setDebugInfo(`Scanning ${scanIds.length} members...`);

            const outRows = new Map<string, Row>();

            // seed UI with cached mutuals
            for (const id of scanIds) {
                const cached = cache.get(id);
                if (cached && cached.length > 0) {
                    const { display, username } = getDisplayName(guildId, id);
                    outRows.set(id, { userId: id, display, username, mutuals: cached });
                }
            }

            if (outRows.size > 0) {
                setRows(
                    Array.from(outRows.values()).sort((a, b) => safeLower(a.display).localeCompare(safeLower(b.display)))
                );
            }

            const concurrency = Math.max(1, settings.store.concurrency);
            const intervalMs = Math.max(0, settings.store.requestDelayMs);
            const maxPauseMs = Math.max(1000, settings.store.maxPauseMs);
            const queue = [...scanIds];

            let completed = 0;
            let foundCount = outRows.size;

            setDebugInfo(`Queued ${queue.length} requests (rescan refreshes cached users too)`);

            async function updatePauseUiFromLimiter() {
                const lim = limiterRef.current;
                if (!lim) return;

                const pu = lim.getPausedUntil();
                if (!pu) {
                    setPausedUntil(null);
                    setStatus(s => (s === "paused" ? "running" : s));
                    return;
                }

                setPausedUntil(pu);
                setStatus(s => (s === "running" ? "paused" : s));
            }

            async function worker() {
                while (!stopRef.current && runIdRef.current === myRunId) {
                    const id = queue.shift();
                    if (!id) return;

                    const lim = limiterRef.current;
                    if (!lim) return;

                    try {
                        await lim.acquire(intervalMs);

                        await updatePauseUiFromLimiter();
                        if (stopRef.current || runIdRef.current !== myRunId) return;

                        const mutuals = await fetchMutualFriends(id);
                        if (stopRef.current || runIdRef.current !== myRunId) return;

                        cache.set(id, mutuals);
                        meta.set(id, Date.now());
                        void writeThroughPersist(guildId, id, mutuals, meta.get(id)!);

                        completed++;

                        if (mutuals.length > 0) {
                            const { display, username } = getDisplayName(guildId, id);
                            outRows.set(id, { userId: id, display, username, mutuals });
                        } else {
                            outRows.delete(id);
                        }

                        foundCount = outRows.size;

                        setRows(
                            Array.from(outRows.values()).sort((a, b) =>
                                safeLower(a.display).localeCompare(safeLower(b.display))
                            )
                        );

                        setDebugInfo(`Scanned ${completed}/${scanIds.length} • Found ${foundCount} with mutuals`);
                        setProgress(p => ({ ...p, done: Math.min(p.total, p.done + 1) }));
                    } catch (e: any) {
                        if (runIdRef.current !== myRunId) return;

                        const ra = getRetryAfterMs(e);
                        const statusCode = e?.status ?? e?.response?.status ?? e?.res?.status;
                        const code =
                            e?.body?.code ??
                            e?.response?.body?.code ??
                            e?.res?.body?.code;

                        // Rate limit handling (existing)
                        if (ra != null || statusCode === 429) {
                            const base = ra ?? 2000;
                            const jitter = 250 + Math.floor(Math.random() * 250);
                            const waitMs = Math.min(maxPauseMs, Math.max(1000, base + jitter));

                            console.warn(`[GuildMutualFriends] Rate limited. Pausing for ${waitMs}ms`, e);

                            const until = Date.now() + waitMs;
                            limiterRef.current?.setPausedUntil(until);

                            await updatePauseUiFromLimiter();

                            queue.unshift(id);
                            continue;
                        }

                        /**
                         * CHANGE #2 (optional, included):
                         * - Do NOT hard-stop the entire scan on Unknown User (10013 / 404)
                         * - Count it as completed and continue scanning
                         */
                        if (statusCode === 404 || code === 10013) {
                            console.warn("[GuildMutualFriends] Skipping unknown user:", id, e);

                            completed++;
                            setDebugInfo(`Scanned ${completed}/${scanIds.length} • Found ${foundCount} with mutuals (skipped unknown user)`);
                            setProgress(p => ({ ...p, done: Math.min(p.total, p.done + 1) }));
                            continue;
                        }

                        const msg = e?.message ?? String(e);
                        console.error("[GuildMutualFriends] Scan error:", e);

                        setErrorText(`Error fetching profile for ${id}: ${msg}`);
                        setDebugInfo(`Failed after ${completed}/${scanIds.length} scans`);
                        stopRef.current = true;
                        setStatus("error");
                        return;
                    }
                }
            }

            await Promise.all(Array.from({ length: concurrency }, () => worker()));

            if (runIdRef.current !== myRunId) return;

            if (stopRef.current) {
                if (status !== "error") setStatus("stopped");
                return;
            }

            setStatus("done");
            setPausedUntil(null);
            setDebugInfo(`Complete • Found ${outRows.size} member(s) with mutual friends`);
        }

        useEffect(() => {
            if (!guildId) return;
            loadCachedRowsNow();
            runScan();
        }, [guildId]);

        useEffect(() => {
            if (status !== "paused" || !pausedUntil) return;

            setNowTick(Date.now());
            const t = setInterval(() => setNowTick(Date.now()), 100);
            return () => clearInterval(t);
        }, [status, pausedUntil]);

        const filtered = useMemo(() => {
            const q = safeLower(query.trim());
            if (!q) return rows;

            return rows.filter(r => {
                if (safeLower(r.display).includes(q)) return true;
                if (safeLower(r.username).includes(q)) return true;

                for (const mf of r.mutuals) {
                    const u = (mf.globalName ?? mf.global_name ?? mf.username ?? "").toString();
                    if (safeLower(u).includes(q)) return true;
                }
                return false;
            });
        }, [rows, query]);

        function close() {
            stopRef.current = true;
            try { onClose?.(); } catch { }
        }

        const canRescan = true;
        const canStop = status === "running" || status === "paused";

        return (
            <>
                <ModalHeader separator={false}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                        <div>
                            <Text variant="text-md/semibold">
                                Mutual Friends — {guildName ?? "Server"}
                            </Text>
                            <Text variant="text-sm/normal" color="text-muted">
                                Shows your mutual friends with each cached member
                            </Text>
                        </div>

                        <div style={{ display: "flex", gap: 8 }}>
                            <MiniButton
                                disabled={!canRescan}
                                onClick={() => {
                                    stopRef.current = true;
                                    setPausedUntil(null);
                                    setStatus("running");
                                    runScan();
                                }}
                            >
                                Rescan
                            </MiniButton>

                            <MiniButton disabled={!canStop} onClick={() => cancel()}>
                                Stop
                            </MiniButton>

                            <MiniButton disabled={false} onClick={() => close()}>
                                Close
                            </MiniButton>
                        </div>
                    </div>
                </ModalHeader>

                <ModalContent
                    onPointerDown={stopAll}
                    onMouseDown={stopAll}
                    onClick={stopAll}
                    onWheel={stopAll}
                >
                    <input
                        value={query}
                        onChange={e => setQuery((e.target as any).value)}
                        placeholder="Search..."
                        onPointerDown={stopAll}
                        onMouseDown={stopAll}
                        onClick={stopAll}
                        style={{
                            width: "100%",
                            padding: "10px 12px",
                            borderRadius: 6,
                            border: "1px solid var(--background-tertiary)",
                            background: "var(--background-secondary)",
                            color: "var(--text-normal)",
                            marginBottom: 10
                        }}
                    />

                    {debugInfo && (
                        <Text variant="text-xs/normal" color="text-muted">
                            {debugInfo}
                        </Text>
                    )}

                    {status === "paused" && (
                        <div
                            style={{
                                padding: 10,
                                borderRadius: 6,
                                background: "var(--background-secondary)",
                                border: "1px solid var(--status-warning)",
                                marginTop: 8
                            }}
                        >
                            <Text variant="text-sm/normal" color="text-warning">
                                Rate limited — scan paused temporarily and will resume automatically.
                            </Text>
                            {pausedUntil && (
                                <Text variant="text-xs/normal" color="text-muted">
                                    Resuming in {Math.max(0, (pausedUntil - nowTick) / 1000).toFixed(1)}s
                                </Text>
                            )}
                        </div>
                    )}

                    {errorText && (
                        <div
                            style={{
                                padding: 10,
                                borderRadius: 6,
                                background: "var(--background-secondary)",
                                border: "1px solid var(--status-danger)",
                                marginTop: 8
                            }}
                        >
                            <Text variant="text-sm/normal" color="text-danger">
                                {errorText}
                            </Text>
                        </div>
                    )}

                    <div
                        onPointerDown={stopAll}
                        onMouseDown={stopAll}
                        onClick={stopAll}
                        onWheel={stopAll}
                        style={{
                            overflow: "auto",
                            maxHeight: "60vh",
                            borderRadius: 8,
                            border: "1px solid var(--background-tertiary)",
                            background: "var(--background-secondary)",
                            marginTop: 10
                        }}
                    >
                        {filtered.length === 0 ? (
                            <div style={{ padding: 12 }}>
                                <Text variant="text-sm/normal" color="text-muted">
                                    {status === "running" || status === "paused"
                                        ? "Scanning..."
                                        : "No mutual friends found with any cached members"}
                                </Text>
                            </div>
                        ) : (
                            filtered.map(r => (
                                <div
                                    key={r.userId}
                                    style={{
                                        padding: 12,
                                        borderBottom: "1px solid var(--background-tertiary)"
                                    }}
                                >
                                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                                        <div>
                                            <div>
                                                <MentionChip
                                                    userId={r.userId}
                                                    label={r.display}
                                                    onStopAll={stopAll}
                                                />
                                            </div>
                                            <Text variant="text-xs/normal" color="text-muted">
                                                @{r.username}
                                            </Text>
                                        </div>
                                        <Text variant="text-sm/normal" color="text-muted">
                                            {r.mutuals.length} mutual{r.mutuals.length !== 1 ? "s" : ""}
                                        </Text>
                                    </div>

                                    <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                                        {r.mutuals.map((m, idx) => {
                                            const label = (m.globalName ?? m.global_name ?? m.username ?? m.id).toString();

                                            if (m.id === "count-only") {
                                                return (
                                                    <Text key={`count-${idx}`} variant="text-sm/normal" color="text-muted">
                                                        {label}
                                                    </Text>
                                                );
                                            }

                                            return (
                                                <React.Fragment key={`${m.id}-${idx}`}>
                                                    <MentionChip
                                                        userId={m.id}
                                                        label={label}
                                                        onStopAll={stopAll}
                                                    />
                                                    {idx !== r.mutuals.length - 1 ? " " : null}
                                                </React.Fragment>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    <Text variant="text-xs/normal" color="text-muted" style={{ marginTop: 10 }}>
                        Showing {filtered.length} member(s) with mutual friends • {progress.done}/{progress.total} scanned
                    </Text>
                </ModalContent>
            </>
        );
    },
    { noop: true }
);

const patchGuildContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const guildId = getGuildIdFromProps(props);
    if (!guildId) return;

    const group = findGroupChildrenByChildId("privacy", children) ?? children;
    if (!Array.isArray(group)) return;

    group.push(
        <Menu.MenuItem
            id="vc-guild-mutual-friends"
            label="Find Mutual Friends"
            action={() => {
                try { props?.onClose?.(); } catch { }
                openMutualModal(guildId, getGuildNameFromProps(props));
            }}
        />
    );
};

export default definePlugin({
    name: "GuildMutualFriends",
    description: "Scans a server for members you share mutual friends with.",
    authors: [{ name: "portgee", id: 1399005225125150871n }],
    settings,

    contextMenus: {
        "guild-context": patchGuildContextMenu,
        "guild-header-popout": patchGuildContextMenu
    },

    async start() {
        console.log("[GuildMutualFriends] Started");
        await loadPersistentIntoMemory();
    },

    async stop() {
        mutualCache.clear();
        mutualMeta.clear();

        if (!settings.store.persistCache) {
            await clearPersistentAll();
        }
    }
});
