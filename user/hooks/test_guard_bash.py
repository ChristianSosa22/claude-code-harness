import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard_bash import decide  # noqa: E402

DENIED = [
    "git push origin main",
    "git push -q origin HEAD:main",
    "DEVELOPER_DIR=/x git push origin feature:master",
    "git push --force origin main",
    "git filter-repo --path secrets.txt --invert-paths",
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -rf .",
    "rm -rf *",
    "rm -rf .git",
    "rm -fr /Users/someone",
    "cd stacks/x && terraform destroy -auto-approve",
    "terraform state rm module.bucket",
    "aws s3 rm s3://bucket/prefix --recursive",
    "aws s3 rb s3://bucket --force",
    "aws s3 sync ./out s3://bucket --delete",
    "aws dynamodb delete-table --table-name t",
    "aws logs delete-log-group --log-group-name g",
    "AWS_PROFILE=x aws stepfunctions delete-state-machine --state-machine-arn a",
    "aws iam put-role-policy --role-name r --policy-name p --policy-document file://p.json",
    "aws iam attach-role-policy --role-name r --policy-arn a",
    "aws athena start-query-execution --query-string 'DROP TABLE db.t'",
    "npx serverless remove --stage dev",
    "gh repo delete org/repo --yes",
    "gh secret delete TOKEN",
    "gh api -X DELETE repos/o/r/git/refs/heads/x",
    "for b in a b; do aws s3 rm s3://x/$b; done",
    "bash -c 'rm -rf /'",
    "npm publish",
]

ASKED = [
    "git push --force origin feature-x",
    "git push -f origin feature-x",
    "git clean -fdx",
    "terraform apply -auto-approve",
    "serverless deploy --stage dev",
    "gh secret set TOKEN < t.txt",
    "gh variable set BEDROCK_MODEL_ID --env prod --body x",
    "gh pr merge 102 --merge",
    "aws secretsmanager get-secret-value --secret-id s",
    "aws ssm get-parameter --name n --with-decryption",
    "sudo rm /etc/hosts",
]

ALLOWED = [
    "git push -q -u origin feature-x",
    "git push -q --force-with-lease=feat/x:f94b070 origin 99023ef:refs/heads/feat/x",
    "git push origin --delete old-branch",
    "git reset --hard origin/feature-x",
    "git branch -D tmp",
    "git log origin/main --oneline",
    "git diff main...HEAD",
    "rm -rf web/e2e/results",
    "rm -rf .terraform .terraform.lock.hcl",
    "rm -rf $S/dry",
    "rm -rf node_modules",
    "terraform fmt -check -recursive stacks/applications/example-app",
    "terraform validate",
    "terraform init -backend=false -input=false",
    "terraform plan",
    "gh workflow run deploy.yml --ref main -f environment=prod",
    "gh workflow run operate.yml --ref main -f environment=prod -f action=nightly-report",
    "gh workflow run verify-dev.yml --ref x -f action=reset -f day=2026-10-06",
    "gh variable set ALLOWED_IDS --env dev < list.txt",
    "gh pr create --draft --title t --body-file b.md",
    "aws logs filter-log-events --log-group-name g",
    "aws s3 cp s3://bucket/key ./local",
    "aws ssm get-parameter --name /example-org/dev/example-app/x",
    "aws stepfunctions start-execution --state-machine-arn a",
    "aws bedrock-agent start-ingestion-job --knowledge-base-id k --data-source-id d",
    "git commit -m 'docs: explain why we never run terraform destroy'",
    "cat > body.md <<'EOF'\nNever run aws s3 rm s3://bucket or git push origin main.\nEOF",
    "grep -rn 'rm -rf /' docs",
    "grep -n \"if:\\|serverless deploy\\|environment:\" .github/workflows/deploy.yml | head -30",
    "echo 'aws s3 rm s3://x; git push origin main' > notes.txt",
]


class GuardBashTest(unittest.TestCase):
    def test_denied(self):
        for command in DENIED:
            with self.subTest(command=command):
                self.assertEqual(decide(command)[0], "deny")

    def test_asked(self):
        for command in ASKED:
            with self.subTest(command=command):
                self.assertEqual(decide(command)[0], "ask")

    def test_allowed(self):
        for command in ALLOWED:
            with self.subTest(command=command):
                self.assertIsNone(decide(command)[0])


if __name__ == "__main__":
    unittest.main()
