# Approve admin browser pairing

Run this only for a fresh code supplied by the verified owner in their private chat. Existing authorized VPS operator access is required; the command grants no SSH or Docker access.

On the VPS, run `/usr/local/bin/ai-pair-approve` and pass the one-time code via standard input. From a computer with an existing trusted SSH alias for that VPS:

```powershell
(Read-Host 'Pairing code') | ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ai-vps /usr/local/bin/ai-pair-approve
```

For a noninteractive caller, pass the code through the executor's stdin mechanism or pipe input from a securely assigned variable. Do not put the code in arguments or persist it in logs. Never copy the server owner token out of the control container.

Exit codes: 0 = server confirmed approval; 64 = invalid input; 65 = unknown or expired; 69 = unavailable or not confirmed. No automatic retry. On success, have the owner click **Finish pairing** in the same browser tab.
