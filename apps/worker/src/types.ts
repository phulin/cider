export interface Env {
	BUCKET: R2Bucket;
	GEMINI_API_KEY: string;
	LINKUP_API_KEY?: string;
	ENVIRONMENT: string;
	PROGRESS_DO: DurableObjectNamespace;
}
