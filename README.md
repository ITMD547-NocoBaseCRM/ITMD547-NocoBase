# ITMD547 NocoBase CRM

## NocoBase 2 application deployed to AWS EC2 with Docker. PostgreSQL stores NocoBase data; Azure SQL stores CRM data.

## Project structure

```text
packages/                 NocoBase packages and plugins
storage/                  Runtime application storage
docs/                     Deployment documentation
Dockerfile                Production container build
docker-compose.ec2.yml    EC2 Compose configuration
.env.example              Safe environment template
.github/workflows/        GitHub Actions automation
package.json              Workspace scripts and dependencies
```

`main` is the deployment branch. `develop` is the integration branch. Compare Dockerfile requirements, package dependencies, plugin directories, and environment templates before merging branches.

## Requirements

- Node.js 22 or newer
- Yarn 1
- Docker and Docker Compose v2
- PostgreSQL
- Optional Azure SQL for CRM data
- Ubuntu AWS EC2 for production deployment

## Local development

```bash
cp .env.example .env
yarn install
yarn dev
```

Default URL: `http://localhost:13000`. Never commit `.env` because it contains credentials and application keys.

Useful scripts include `yarn start`, `yarn dev`, `yarn build`, `yarn test`, `yarn e2e`, `yarn lint`, and `yarn clean`.

## Docker

```bash
docker compose -f docker-compose.ec2.yml up -d --build
docker compose -f docker-compose.ec2.yml logs -f nocobase
```

The container listens on port `13000` and uses the `nocobase-storage` volume.

Compose loads `.env`, maps host port `13000` to the container, persists `/app/storage`, and restarts the container after failure.

## EC2 deployment

The production directory is `/opt/parlour-crm/app`; the production environment file is `/opt/parlour-crm/app/.env`.

See [docs/ec2-deployment.md](docs/ec2-deployment.md) for setup instructions. The EC2 security group must allow TCP port `13000` from approved client IPs.

For production, restrict SSH to an administrator IP and place NocoBase behind HTTPS instead of exposing port `13000` publicly.

Azure SQL must allow the EC2 public egress IP in its firewall. Verify the connection with:

```bash
docker compose -f docker-compose.ec2.yml restart nocobase
docker compose -f docker-compose.ec2.yml logs --tail=100 nocobase
```

Successful startup includes `Azure SQL connected` and `status=running`.

## CI/CD

GitHub Actions deploys from `main` using [.github/workflows/deploy-ec2.yml](.github/workflows/deploy-ec2.yml). It pulls code, cleans Docker cache, builds the image, restarts NocoBase, and retries the health check.

Required repository secrets:

```text
EC2_HOST
EC2_USERNAME
EC2_SSH_KEY_B64
```

`EC2_SSH_KEY_B64` is the base64-encoded EC2 private key. Never commit the private key or `.env` file.

## Databases

PostgreSQL is the primary NocoBase database and is configured with the `DB_*` variables. It stores users, UI layouts, plugin state, workflows, and application records.

Azure SQL is an optional external CRM database configured with `AZURE_SQL_*` variables over TCP port `1433`. Its firewall must allow the EC2 public egress IP. Successful startup includes `Azure SQL connected` and `status=running`.

## Security

- Use a strong random `APP_KEY`.
- Change the initial administrator password after first login.
- Keep `.env`, private keys, database passwords, and API keys out of Git.
- Restrict SSH and port `13000` access.
- Use AWS Secrets Manager or Systems Manager Parameter Store for production secrets.
- Rotate credentials exposed in logs, screenshots, commits, or chat.

## Troubleshooting

```bash
docker compose -f docker-compose.ec2.yml ps
docker compose -f docker-compose.ec2.yml logs -f nocobase
df -h /
docker system df
```

For `ENOSPC`, remove unused Docker artifacts with `docker system prune -af`. For Azure SQL timeouts, verify the Azure firewall, EC2 public IP, outbound TCP 1433, and `AZURE_SQL_*` variables.
