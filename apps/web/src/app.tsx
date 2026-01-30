import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import "./app.css";

export default function App() {
	return (
		<Router
			root={(props) => (
				<div class="min-h-screen bg-gray-50">
					<header class="bg-white border-b border-gray-200">
						<div class="max-w-4xl mx-auto px-4 py-4">
							<a href="/" class="text-xl font-semibold text-gray-900">
								Cider
							</a>
							<span class="ml-2 text-sm text-gray-500">Citation Checker</span>
						</div>
					</header>
					<main class="max-w-4xl mx-auto px-4 py-8">
						<Suspense fallback={<div class="text-gray-500">Loading...</div>}>
							{props.children}
						</Suspense>
					</main>
				</div>
			)}
		>
			<FileRoutes />
		</Router>
	);
}
