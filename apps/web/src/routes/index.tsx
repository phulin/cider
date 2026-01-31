import { useNavigate } from "@solidjs/router";
import { createSignal } from "solid-js";
import { uploadDocument } from "~/lib/api";

export default function Home() {
	const navigate = useNavigate();
	const [file, setFile] = createSignal<File | null>(null);
	const [uploading, setUploading] = createSignal(false);
	const [progress, setProgress] = createSignal(0);
	const [error, setError] = createSignal<string | null>(null);
	const [dragOver, setDragOver] = createSignal(false);

	const handleFile = (f: File | null) => {
		setError(null);
		if (f && !f.name.endsWith(".docx")) {
			setError("Only .docx files are supported");
			return;
		}
		setFile(f);
	};

	const handleDrop = (e: DragEvent) => {
		e.preventDefault();
		setDragOver(false);
		const f = e.dataTransfer?.files[0];
		if (f) handleFile(f);
	};

	const handleUpload = async () => {
		const f = file();
		if (!f) return;

		setUploading(true);
		setProgress(0);
		setError(null);

		try {
			const result = await uploadDocument(f, setProgress);
			setProgress(100);
			navigate(`/documents/${result.id}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Upload failed");
			setUploading(false);
			setProgress(0);
		}
	};

	return (
		<div class="space-y-8">
			<div class="text-center">
				<h1 class="text-3xl font-bold text-gray-900">Check Your Citations</h1>
				<p class="mt-2 text-gray-600">
					Upload a Word document and we'll verify each footnote against its
					source.
				</p>
			</div>

			{/* biome-ignore lint/a11y/noStaticElementInteractions: Drop zone requires drag events */}
			<div
				class={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
					dragOver()
						? "border-blue-500 bg-blue-50"
						: "border-gray-300 hover:border-gray-400"
				}`}
				onDragOver={(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={handleDrop}
			>
				{file() ? (
					<div class="space-y-4">
						<div class="text-gray-900 font-medium">{file()?.name}</div>
						<div class="text-sm text-gray-500">
							{((file()?.size ?? 0) / 1024).toFixed(1)} KB
						</div>
						<button
							type="button"
							onClick={() => setFile(null)}
							class="text-sm text-red-600 hover:text-red-700"
						>
							Remove
						</button>
					</div>
				) : (
					<div class="space-y-4">
						<div class="text-gray-500">Drag and drop a .docx file here, or</div>
						<label class="inline-block cursor-pointer">
							<span class="px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50">
								Choose File
							</span>
							<input
								type="file"
								accept=".docx"
								class="hidden"
								onChange={(e) => handleFile(e.target.files?.[0] || null)}
							/>
						</label>
					</div>
				)}
			</div>

			{error() && (
				<div class="p-4 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
					{error()}
				</div>
			)}

			<div class="flex justify-center">
				<div class="w-full max-w-md space-y-3">
					<button
						type="button"
						onClick={handleUpload}
						disabled={!file() || uploading()}
						class={`w-full px-6 py-3 rounded-md font-medium text-white transition-colors ${
							!file() || uploading()
								? "bg-gray-300 cursor-not-allowed"
								: "bg-blue-600 hover:bg-blue-700"
						}`}
					>
						{uploading() ? "Uploading..." : "Check Citations"}
					</button>
					{uploading() && (
						<div class="space-y-2">
							<div class="flex items-center justify-between text-xs text-gray-500">
								<span>Uploading document</span>
								<span>{progress()}%</span>
							</div>
							<div
								class="h-2 w-full overflow-hidden rounded-full bg-gray-200"
								role="progressbar"
								aria-valuemin="0"
								aria-valuemax="100"
								aria-valuenow={progress()}
							>
								<div
									class="h-full rounded-full bg-blue-600 transition-all duration-200"
									style={{ width: `${progress()}%` }}
								/>
							</div>
						</div>
					)}
				</div>
			</div>

			<div class="mt-12 text-center text-sm text-gray-500">
				<p>
					We'll extract footnotes from your document and verify each citation
					against its source using AI.
				</p>
			</div>
		</div>
	);
}
