// Generates a stopped ChatGPT-plan installation. Never echoes credentials.
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
if(existsSync('.env'))throw new Error('Refusing to overwrite existing configuration');
const secret=()=>randomBytes(32).toString('hex');
const pg=secret(),s3=secret();
const env={OWNER_TOKEN:secret(),RUNTIME_TOKEN:secret(),MEMORY_TOKEN:secret(),PUBLIC_VIEW_TOKEN:secret(),WEB_CHAT_TOKEN:secret(),MODEL_BACKEND:'chatgpt-plan',MODEL_ENABLED:'false',CHATGPT_PLAN_CAP_CONFIRMED:'false',CHATGPT_PLAN_CAP_PERCENT:'50',MODEL_API_KEY:'',MODEL_BASE_URL:'https://openrouter.ai/api/v1',MODEL:'gpt-6-luna',LINKEDIN_URL:'',INPUT_TOKEN_PRICE:'0.00000015',OUTPUT_TOKEN_PRICE:'0.0000006',MODEL_BUDGET_USD:'10',LANGFUSE_IMAGE_TAG:'4.82.0',LANGFUSE_PUBLIC_KEY:`pk-lf-${secret()}`,LANGFUSE_SECRET_KEY:`sk-lf-${secret()}`,LANGFUSE_OWNER_PASSWORD:secret(),NEXTAUTH_URL:'http://localhost:3000',NEXTAUTH_SECRET:secret(),SALT:secret(),ENCRYPTION_KEY:secret(),POSTGRES_PASSWORD:pg,DATABASE_URL:`postgresql://postgres:${pg}@postgres:5432/postgres`,CLICKHOUSE_PASSWORD:secret(),REDIS_AUTH:secret(),MINIO_ROOT_USER:'minio',MINIO_ROOT_PASSWORD:s3,LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID:'minio',LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY:s3,LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID:'minio',LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY:s3,LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID:'minio',LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY:s3,TELEMETRY_ENABLED:'false'};
writeFileSync('.env',Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log('Configuration generated. Credentials were not printed.');
