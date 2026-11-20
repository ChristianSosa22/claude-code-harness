#!/usr/bin/env python3
# Deploys through CI stay allowed on purpose, so the agent can prove a feature end to end. The lists
# below cover only what is irreversible.
import json
import os
import re
import sys
from datetime import datetime, timezone

LOG_PATH = os.path.expanduser("~/.claude/hooks/guard-bash.log.jsonl")

# A rule matches the start of one command segment, after the prefixes in strip_prefixes().
DENY = [
    ("git push to main or master",
     r"git\s+(-C\s+\S+\s+)?push\b.*(\s|:|/)(main|master)(\s|$)"),
    ("git history rewrite",
     r"git\s+(-C\s+\S+\s+)?(filter-branch|filter-repo)\b"),
    ("rm -rf on a root, home or repository-wide path",
     r"rm\s+(-\w+\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(\"|')?(/|~|\$HOME|\.\.?|\*|\.git|/Users/[^/\s]+)(\"|')?/?(\s|$)"),
    ("terraform destroy or state surgery",
     r"terraform\s+(-chdir=\S+\s+)?(destroy|state\s+(rm|mv|push|replace-provider)|force-unlock|taint)\b"),
    ("AWS delete, remove or terminate",
     r"aws\s+\S+\s+(delete|remove|terminate|deregister|purge|disable-key|schedule-key-deletion)[\w-]*\b"),
    ("AWS S3 delete",
     r"aws\s+s3\s+(rm|rb)\b|aws\s+s3\s+sync\b.*\s--delete\b"),
    ("AWS IAM, KMS, Organizations or SSO change (belongs in infrastructure as code)",
     r"aws\s+(iam|kms|organizations|sso-admin|identitystore)\s+(create|put|attach|detach|update|add|tag|untag|set|enable|upload)[\w-]*\b"),
    ("destructive SQL through Athena",
     r"aws\s+athena\s+start-query-execution\b.*\b(DROP|DELETE|TRUNCATE|ALTER)\b"),
    ("serverless remove",
     r"(npx\s+)?(sls|serverless)\s+remove\b"),
    ("GitHub repository, release or secret delete",
     r"gh\s+(repo\s+(delete|archive)|release\s+delete|secret\s+delete|variable\s+delete)\b"),
    ("GitHub API delete",
     r"gh\s+api\b.*(-X|--method)\s*DELETE\b"),
    ("disk-level write",
     r"(dd\s+if=|mkfs\b|diskutil\s+(erase|partition))"),
    ("package publish",
     r"(npm|pnpm|yarn)\s+publish\b"),
]

ASK = [
    ("plain force push (use --force-with-lease)",
     r"git\s+(-C\s+\S+\s+)?push\b(?!.*--force-with-lease).*(\s--force\b|\s-f\b|\s\+\S)"),
    ("git clean of untracked files",
     r"git\s+(-C\s+\S+\s+)?clean\s+-\w*f"),
    ("terraform apply or import outside CI",
     r"terraform\s+(-chdir=\S+\s+)?(apply|import)\b"),
    ("local serverless deploy (deploys go through CI)",
     r"(npx\s+)?(sls|serverless)\s+deploy\b"),
    ("GitHub secret change",
     r"gh\s+secret\s+set\b"),
    ("prod GitHub variable change",
     r"gh\s+variable\s+set\b.*--env\s+prod\b"),
    ("PR merge",
     r"gh\s+pr\s+merge\b"),
    ("secret value read",
     r"aws\s+secretsmanager\s+get-secret-value\b|aws\s+ssm\s+get-parameters?\b.*--with-decryption"),
    ("DynamoDB bulk write",
     r"aws\s+dynamodb\s+batch-write-item\b"),
    ("sudo",
     r"sudo\s"),
]

PREFIX = re.compile(
    r"^(\s*(\w+=(\"[^\"]*\"|'[^']*'|\S*)\s+|do\s+|then\s+|else\s+|time\s+|command\s+|exec\s+|nohup\s+|!\s*|\(\s*|\{\s*))+"
)


def strip_heredoc_bodies(command):
    out, lines, i = [], command.split("\n"), 0
    while i < len(lines):
        out.append(lines[i])
        match = re.search(r"<<-?\s*['\"]?(\w+)['\"]?", lines[i])
        i += 1
        if match:
            while i < len(lines) and lines[i].strip() != match.group(1):
                i += 1
            i += 1
    return "\n".join(out)


def split_outside_quotes(text):
    parts, current, quote, i = [], [], None, 0
    while i < len(text):
        ch = text[i]
        if quote:
            current.append(ch)
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            current.append(ch)
        elif text.startswith("$(", i):
            parts.append("".join(current))
            current = []
            i += 1
        elif ch in "\n;|&`()":
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    parts.append("".join(current))
    return parts


def segments(command):
    text = strip_heredoc_bodies(command)
    inner = re.findall(r"\b(?:bash|sh|zsh|eval)\s+(?:-\w+\s+)*-c\s+(\"[^\"]*\"|'[^']*')", text)
    for chunk in [text] + [s[1:-1] for s in inner]:
        for part in split_outside_quotes(chunk):
            part = PREFIX.sub("", part.strip())
            if part:
                yield part


def decide(command):
    for seg in segments(command):
        for name, pattern in DENY:
            if re.match(pattern, seg):
                return "deny", name, seg
    for seg in segments(command):
        for name, pattern in ASK:
            if re.match(pattern, seg):
                return "ask", name, seg
    return None, None, None


def log(entry):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
        command = payload.get("tool_input", {}).get("command", "")
    except (ValueError, AttributeError):
        return 0
    decision, rule, seg = decide(command)
    if decision is None:
        return 0
    log({
        "time": datetime.now(timezone.utc).isoformat(),
        "decision": decision,
        "rule": rule,
        "segment": seg[:300],
        "cwd": payload.get("cwd"),
        "session": payload.get("session_id"),
    })
    if decision == "deny":
        reason = (f"Blocked by guard-bash: {rule}. This action is not allowed for the agent. "
                  "Stop and tell the user the exact command so they can run it themselves if they want it.")
    else:
        reason = f"guard-bash: {rule}. Needs the user's approval."
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
