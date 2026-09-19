# EC2 deployment

This deployment runs NocoBase in Docker on an EC2 instance and keeps the CRM
connection pointed at Azure SQL. The NocoBase application database remains the
PostgreSQL database configured by `DB_*` variables.

## EC2 setup

Use an Ubuntu LTS EC2 instance with a security group allowing:

- TCP 22 from your administrator IP only
- TCP 80 and 443 from the internet
- TCP 13000 only temporarily for initial testing, or only from your proxy

Install Docker and Compose, clone the repository, and create the environment:

```bash
cp .env.example .env
nano .env
docker compose -f docker-compose.ec2.yml up -d --build
docker compose -f docker-compose.ec2.yml logs -f nocobase
```

NocoBase will listen on port `13000`. Before production use, put Nginx or an
AWS load balancer in front of it for HTTPS and stop exposing port 13000
publicly.

## Azure SQL firewall

Allow the EC2 instance's stable public egress IP in the Azure SQL firewall and
confirm that outbound TCP 1433 is allowed by the EC2 security group and subnet
network ACL. Do not commit `.env`; keep credentials on the instance or inject
them through a secrets manager.
