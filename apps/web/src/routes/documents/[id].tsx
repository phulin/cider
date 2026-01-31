import type { Footnote, Verdict, Verification } from "@cider/shared";
import { useParams } from "@solidjs/router";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { type DocumentResult, documentStreamUrl, getDocument } from "~/lib/api";

const verdictConfig: Record<
	Verdict,
	{ label: string; color: string; bg: string }
> = {
	supports: {
		label: "Supports",
		color: "text-green-700",
		bg: "bg-green-50 border-green-200",
	},
	partially_supports: {
		label: "Partially Supports",
		color: "text-yellow-700",
		bg: "bg-yellow-50 border-yellow-200",
	},
	does_not_support: {
		label: "Does Not Support",
		color: "text-orange-700",
		bg: "bg-orange-50 border-orange-200",
	},
	contradicts: {
		label: "Contradicts",
		color: "text-red-700",
		bg: "bg-red-50 border-red-200",
	},
	source_unavailable: {
		label: "Source Unavailable",
		color: "text-gray-600",
		bg: "bg-gray-50 border-gray-200",
	},
};

function FootnoteCard(props: {
	footnote: Footnote;
	verification?: Verification;
	traceOpen?: boolean;
	onTraceToggle?: (open: boolean) => void;
	traceOutputOpenByIndex?: Record<number, boolean>;
	onTraceOutputToggle?: (index: number, open: boolean) => void;
}) {
	const config = () =>
		props.verification
			? verdictConfig[props.verification.verdict]
			: verdictConfig.source_unavailable;

	return (
		<div class={`p-4 rounded-lg border ${config().bg}`}>
			<div class="flex items-start justify-between gap-4">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 mb-2">
						<span class="font-mono text-sm text-gray-500">
							[{props.footnote.displayIndex ?? props.footnote.index}]
						</span>
						<Show when={props.verification}>
							<span class={`text-sm font-medium ${config().color}`}>
								{config().label}
							</span>
							<span class="text-xs text-gray-400">
								({Math.round((props.verification?.confidence || 0) * 100)}%
								confidence)
							</span>
						</Show>
					</div>

					<p class="text-gray-900 mb-2">{props.footnote.claim}</p>

					<p class="text-sm text-gray-600 italic">
						"{props.footnote.citation}"
					</p>

					<Show when={props.verification?.explanation}>
						<p class="mt-3 text-sm text-gray-700">
							{props.verification?.explanation}
						</p>
					</Show>

					<Show when={props.verification?.sourceUrl}>
						<a
							href={props.verification?.sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="mt-2 inline-block text-sm text-blue-600 hover:text-blue-700"
						>
							View Source
						</a>
					</Show>

					<Show
						when={
							props.verification?.trace && props.verification.trace.length > 0
						}
					>
						<details
							class="mt-3"
							open={props.traceOpen}
							onToggle={(event) =>
								props.onTraceToggle?.(
									(event.currentTarget as HTMLDetailsElement).open,
								)
							}
						>
							<summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
								Show agent trace ({props.verification?.trace?.length} tool
								calls)
							</summary>
							<div class="mt-2 space-y-2 text-xs">
								<For each={props.verification?.trace}>
									{(call, index) => (
										<div class="border border-gray-200 rounded p-2 bg-white">
											<div class="flex items-center gap-2 mb-1">
												<span class="font-mono font-semibold text-purple-600">
													{index() + 1}. {call.tool}
												</span>
											</div>
											<div class="text-gray-600">
												<span class="font-medium">Input:</span>{" "}
												<code class="bg-gray-100 px-1 rounded">
													{JSON.stringify(call.input)}
												</code>
											</div>
											<details
												class="mt-1"
												open={props.traceOutputOpenByIndex?.[index()] ?? false}
												onToggle={(event) =>
													props.onTraceOutputToggle?.(
														index(),
														(event.currentTarget as HTMLDetailsElement).open,
													)
												}
											>
												<summary class="text-gray-500 cursor-pointer hover:text-gray-700">
													Output ({call.output.length} chars)
												</summary>
												<pre class="mt-1 p-2 bg-gray-100 rounded overflow-x-auto whitespace-pre-wrap text-gray-700 max-h-48 overflow-y-auto">
													{call.output}
												</pre>
											</details>
										</div>
									)}
								</For>
							</div>
						</details>
					</Show>
				</div>
			</div>
		</div>
	);
}

export default function DocumentPage() {
	const params = useParams();
	const [result, setResult] = createSignal<DocumentResult | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [polling, setPolling] = createSignal(false);
	const [traceOpenByFootnote, setTraceOpenByFootnote] = createSignal<
		Record<string, boolean>
	>({});
	const [traceOutputOpenByFootnote, setTraceOutputOpenByFootnote] =
		createSignal<Record<string, Record<number, boolean>>>({});

	const fetchDocument = async () => {
		try {
			const id = params.id;
			if (!id) return;
			const data = await getDocument(id);
			setResult(data);

			// Stop polling if complete or failed
			if (data.document.status !== "processing") {
				setPolling(false);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load document");
			setPolling(false);
		}
	};

	// Initial fetch on id change
	createEffect(() => {
		if (!params.id) return;
		fetchDocument();
	});

	// WebSocket stream
	createEffect(() => {
		const id = params.id;
		if (!id) return;

		let closed = false;
		const ws = new WebSocket(documentStreamUrl(id));

		ws.addEventListener("open", () => {
			setPolling(false);
		});

		ws.addEventListener("message", (event) => {
			try {
				const payload = JSON.parse(event.data as string) as {
					type: string;
					data?: {
						status: "processing" | "complete" | "failed";
						footnoteCount: number;
						verifications: Verification[];
						error?: string;
					};
				};

				if (payload.type !== "progress" || !payload.data) return;
				const data = payload.data;

				setResult((prev) => {
					if (!prev) return prev;
					return {
						...prev,
						document: {
							...prev.document,
							status: data.status,
							footnoteCount: data.footnoteCount,
							...(data.error ? { error: data.error } : {}),
						},
						verifications: data.verifications,
					};
				});

				if (data.status !== "processing" && !closed) {
					closed = true;
					ws.close();
				}
			} catch (err) {
				console.warn("Failed to parse progress message", err);
			}
		});

		const handleClose = () => {
			const status = result()?.document.status;
			if (!status || status === "processing") {
				setPolling(true);
			}
		};

		ws.addEventListener("close", handleClose);
		ws.addEventListener("error", handleClose);

		onCleanup(() => {
			closed = true;
			ws.close();
		});
	});

	// Polling fallback when WS is unavailable
	createEffect(() => {
		if (!polling()) return;
		fetchDocument();

		const interval = setInterval(() => {
			fetchDocument();
		}, 3000);

		onCleanup(() => clearInterval(interval));
	});

	const verificationMap = () => {
		const map = new Map<string, Verification>();
		for (const v of result()?.verifications || []) {
			map.set(v.footnoteId, v);
		}
		return map;
	};

	const stats = () => {
		const verifications = result()?.verifications || [];
		if (verifications.length === 0) return null;

		const counts: Record<Verdict, number> = {
			supports: 0,
			partially_supports: 0,
			does_not_support: 0,
			contradicts: 0,
			source_unavailable: 0,
		};

		for (const v of verifications) {
			counts[v.verdict]++;
		}

		return counts;
	};

	const verificationProgress = () => {
		const footnoteCount = result()?.document.footnoteCount ?? 0;
		if (footnoteCount === 0) return 0;
		const verified = result()?.verifications.length ?? 0;
		return Math.min(
			100,
			Math.max(0, Math.round((verified / footnoteCount) * 100)),
		);
	};

	return (
		<div class="space-y-6">
			<Show when={error()}>
				<div class="p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
					{error()}
				</div>
			</Show>

			<Show when={result()}>
				<div class="flex items-center justify-between">
					<div>
						<h1 class="text-2xl font-bold text-gray-900">
							{result()?.document.filename}
						</h1>
						<p class="text-sm text-gray-500">
							{result()?.document.footnoteCount} footnotes
						</p>
					</div>

					<Show
						when={result()?.document.status === "processing"}
						fallback={
							<span
								class={`px-3 py-1 rounded-full text-sm font-medium ${
									result()?.document.status === "complete"
										? "bg-green-100 text-green-700"
										: "bg-red-100 text-red-700"
								}`}
							>
								{result()?.document.status === "complete"
									? "Complete"
									: "Failed"}
							</span>
						}
					>
						<div class="flex flex-col items-end gap-2">
							<div class="flex items-center gap-2">
								<div class="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
								<span class="text-sm text-gray-600">
									Verifying citations...
								</span>
							</div>
							<div class="w-64 space-y-1">
								<div class="flex items-center justify-between text-xs text-gray-500">
									<span>
										{result()?.verifications.length ?? 0} of{" "}
										{result()?.document.footnoteCount ?? 0} verified
									</span>
									<span>{verificationProgress()}%</span>
								</div>
								<div
									class="h-2 w-full overflow-hidden rounded-full bg-gray-200"
									role="progressbar"
									aria-valuemin="0"
									aria-valuemax="100"
									aria-valuenow={verificationProgress()}
								>
									<div
										class="h-full rounded-full bg-blue-600 transition-all duration-300"
										style={{ width: `${verificationProgress()}%` }}
									/>
								</div>
							</div>
						</div>
					</Show>
				</div>

				<Show when={stats()}>
					<div class="grid grid-cols-5 gap-2">
						<For each={Object.entries(stats() ?? {})}>
							{([verdict, count]) => (
								<div
									class={`p-3 rounded-lg text-center ${verdictConfig[verdict as Verdict].bg}`}
								>
									<div
										class={`text-xl font-bold ${verdictConfig[verdict as Verdict].color}`}
									>
										{count}
									</div>
									<div class="text-xs text-gray-600">
										{verdictConfig[verdict as Verdict].label}
									</div>
								</div>
							)}
						</For>
					</div>
				</Show>

				<div class="space-y-4">
					<For each={result()?.footnotes}>
						{(footnote) => (
							<FootnoteCard
								footnote={footnote}
								verification={verificationMap().get(footnote.id)}
								traceOpen={traceOpenByFootnote()[footnote.id] ?? false}
								onTraceToggle={(open) =>
									setTraceOpenByFootnote((prev) => ({
										...prev,
										[footnote.id]: open,
									}))
								}
								traceOutputOpenByIndex={
									traceOutputOpenByFootnote()[footnote.id] ?? {}
								}
								onTraceOutputToggle={(index, open) =>
									setTraceOutputOpenByFootnote((prev) => ({
										...prev,
										[footnote.id]: {
											...(prev[footnote.id] ?? {}),
											[index]: open,
										},
									}))
								}
							/>
						)}
					</For>
				</div>

				<Show when={result()?.footnotes.length === 0}>
					<div class="text-center py-12 text-gray-500">
						No footnotes found in this document.
					</div>
				</Show>
			</Show>

			<Show when={!result() && !error()}>
				<div class="text-center py-12">
					<div class="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
					<p class="mt-4 text-gray-500">Loading document...</p>
				</div>
			</Show>
		</div>
	);
}
