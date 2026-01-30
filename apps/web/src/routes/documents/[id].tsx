import type { Footnote, Verdict, Verification } from "@cider/shared";
import { useParams } from "@solidjs/router";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { type DocumentResult, getDocument } from "~/lib/api";

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
							[{props.footnote.index}]
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
						<details class="mt-3">
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
											<details class="mt-1">
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
	const [polling, setPolling] = createSignal(true);

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

	// Initial fetch and polling
	createEffect(() => {
		fetchDocument();

		const interval = setInterval(() => {
			if (polling()) {
				fetchDocument();
			}
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
						<div class="flex items-center gap-2">
							<div class="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
							<span class="text-sm text-gray-600">Verifying citations...</span>
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
