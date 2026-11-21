# PoC

1. A private Pi runner performs two consecutive turns in one session, the second using the previous result, then stops. Pi uses the existing production goal and work prompts; its first working surface is a sandbox with no external effects.
2. Each completed turn publishes its goal, action and result. Langfuse receives one trace with generation observations. Authentication data and reasoning are never published.
3. The public feed shows current status and prior turns. When no run exists, it shows a clearly labeled sample. The page does not control the owner's subscription.
4. The owner can interrupt a run independently of the model. No deployment or reboot restarts a model run.
5. The VPS automatically pulls the dedicated preview branch; it serves complete revisions and reports the deployed commit.
