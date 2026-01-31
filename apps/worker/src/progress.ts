import type { Document, Verification } from "@cider/shared";
import type { Env } from "./types";

export interface ProgressUpdate {
	status: Document["status"];
	footnoteCount: number;
	verifications: Verification[];
	error?: string;
	updatedAt?: string;
}

export interface ProgressSnapshot extends ProgressUpdate {
	updatedAt: string;
}

interface SqlPreparedStatement {
	bind(...args: unknown[]): SqlPreparedStatement;
	run(): Promise<void> | void;
	all<T = Record<string, unknown>>():
		| Promise<{ results: T[] } | T[]>
		| { results: T[] }
		| T[];
	first<T = Record<string, unknown>>(): Promise<T | null> | T | null;
}

interface SqlStorage {
	prepare(query: string): SqlPreparedStatement;
	exec(query: string): Promise<void> | void;
}

interface ProgressStore {
	initialize(): Promise<void>;
	get(): Promise<ProgressSnapshot | null>;
	set(payload: ProgressUpdate): Promise<ProgressSnapshot>;
}

function getSqlStorage(state: DurableObjectState): SqlStorage | null {
	const storage = state.storage as unknown as { sql?: SqlStorage };
	if (!storage.sql || typeof storage.sql.prepare !== "function") {
		return null;
	}
	return storage.sql;
}

function createKvStore(state: DurableObjectState): ProgressStore {
	const key = "progress";
	return {
		async initialize() {},
		async get() {
			return (await state.storage.get<ProgressSnapshot>(key)) ?? null;
		},
		async set(payload) {
			const updatedAt = payload.updatedAt ?? new Date().toISOString();
			const snapshot: ProgressSnapshot = {
				status: payload.status,
				updatedAt,
				footnoteCount: payload.footnoteCount,
				verifications: payload.verifications ?? [],
				error: payload.error,
			};
			await state.storage.put(key, snapshot);
			return snapshot;
		},
	};
}

export class ProgressDurableObject {
	private readonly state: DurableObjectState;
	private readonly store: ProgressStore;
	private readonly sessions = new Set<WebSocket>();
	private readonly initPromise: Promise<void>;

	constructor(state: DurableObjectState, _env: Env) {
		this.state = state;
		const sql = getSqlStorage(state);
		this.store = sql ? createSqlStore(sql) : createKvStore(state);
		this.initPromise = this.store.initialize();

		for (const ws of state.getWebSockets()) {
			this.sessions.add(ws);
			this.attachWebSocket(ws);
		}
	}

	async fetch(request: Request): Promise<Response> {
		await this.initPromise;

		const upgradeHeader = request.headers.get("Upgrade");
		if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];

			this.state.acceptWebSocket(server);
			this.sessions.add(server);
			this.attachWebSocket(server);

			await this.sendSnapshot(server);

			return new Response(null, { status: 101, webSocket: client });
		}

		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/progress") {
			const payload = (await request.json()) as ProgressUpdate;
			const snapshot = await this.setProgress(payload);
			this.broadcast(snapshot);
			return new Response(null, { status: 204 });
		}

		if (request.method === "GET" && url.pathname === "/progress") {
			const snapshot = await this.getProgress();
			return Response.json(snapshot ?? null);
		}

		return new Response("Not found", { status: 404 });
	}

	private attachWebSocket(ws: WebSocket): void {
		ws.addEventListener("close", () => {
			this.sessions.delete(ws);
		});
		ws.addEventListener("error", () => {
			this.sessions.delete(ws);
		});
		ws.addEventListener("message", (event) => {
			if (typeof event.data === "string" && event.data === "ping") {
				ws.send("pong");
			}
		});
	}

	private async getProgress(): Promise<ProgressSnapshot | null> {
		return this.store.get();
	}

	private async setProgress(
		payload: ProgressUpdate,
	): Promise<ProgressSnapshot> {
		return this.store.set(payload);
	}

	private broadcast(snapshot: ProgressSnapshot): void {
		const message = JSON.stringify({ type: "progress", data: snapshot });
		for (const ws of this.sessions) {
			try {
				ws.send(message);
			} catch {
				this.sessions.delete(ws);
			}
		}
	}

	private async sendSnapshot(ws: WebSocket): Promise<void> {
		const snapshot = await this.getProgress();
		if (!snapshot) return;
		ws.send(JSON.stringify({ type: "progress", data: snapshot }));
	}
}

function createSqlStore(sql: SqlStorage): ProgressStore {
	return {
		async initialize() {
			await Promise.resolve(
				sql.exec(
					"CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL, updated_at TEXT NOT NULL, footnote_count INTEGER NOT NULL, verifications_json TEXT NOT NULL, error TEXT)",
				),
			);
		},
		async get() {
			const stmt = sql.prepare(
				"SELECT status, updated_at, footnote_count, verifications_json, error FROM progress WHERE id = 1",
			);
			const row = await readFirstRow(stmt);
			if (!row) return null;
			return {
				status: row.status as ProgressSnapshot["status"],
				updatedAt: row.updated_at as string,
				footnoteCount: Number(row.footnote_count ?? 0),
				verifications: JSON.parse(
					(row.verifications_json as string) || "[]",
				) as Verification[],
				error: row.error as string | undefined,
			};
		},
		async set(payload) {
			const updatedAt = payload.updatedAt ?? new Date().toISOString();
			const verificationsJson = JSON.stringify(payload.verifications ?? []);
			const stmt = sql.prepare(
				"INSERT INTO progress (id, status, updated_at, footnote_count, verifications_json, error) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, footnote_count = excluded.footnote_count, verifications_json = excluded.verifications_json, error = excluded.error",
			);
			await Promise.resolve(
				stmt
					.bind(
						payload.status,
						updatedAt,
						payload.footnoteCount,
						verificationsJson,
						payload.error ?? null,
					)
					.run(),
			);
			return {
				status: payload.status,
				updatedAt,
				footnoteCount: payload.footnoteCount,
				verifications: payload.verifications ?? [],
				error: payload.error,
			};
		},
	};
}

async function readFirstRow(
	stmt: SqlPreparedStatement,
): Promise<Record<string, unknown> | null> {
	if (typeof stmt.first === "function") {
		return (await stmt.first<Record<string, unknown>>()) ?? null;
	}

	const result = await Promise.resolve(stmt.all<Record<string, unknown>>());
	if (Array.isArray(result)) {
		return result[0] ?? null;
	}
	return result.results?.[0] ?? null;
}
