# NocoBase CRM

NocoBase 2 application deployed to AWS EC2 with Docker. PostgreSQL stores NocoBase data; Azure SQL stores CRM data.

## Local development

```bash
cp .env.example .env
yarn install
yarn dev
```

Default URL: `http://localhost:13000`. Never commit `.env` because it contains credentials and application keys.

## Docker

```bash
docker compose -f docker-compose.ec2.yml up -d --build
docker compose -f docker-compose.ec2.yml logs -f nocobase
```

The container listens on port `13000` and uses the `nocobase-storage` volume.

## EC2 deployment

The production directory is `/opt/parlour-crm/app`; the production environment file is `/opt/parlour-crm/app/.env`.

See [docs/ec2-deployment.md](docs/ec2-deployment.md) for setup instructions. The EC2 security group must allow TCP port `13000` from approved client IPs.

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

## Troubleshooting

```bash
docker compose -f docker-compose.ec2.yml ps
docker compose -f docker-compose.ec2.yml logs -f nocobase
df -h /
docker system df
```

For `ENOSPC`, remove unused Docker artifacts with `docker system prune -af`. For Azure SQL timeouts, verify the Azure firewall, EC2 public IP, outbound TCP 1433, and `AZURE_SQL_*` variables.
