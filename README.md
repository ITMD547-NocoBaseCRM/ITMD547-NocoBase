# Parlour CRM

Parlour CRM is a CRM application built with **NocoBase 2** and a custom NocoBase plugin.

The custom CRM plugin is located at:

```text
packages/plugins/@parlour/plugin-crm
```

## Architecture

The project uses two databases for different purposes:

```text
NocoBase
├── Neon PostgreSQL
│   └── NocoBase system data
│       (users, permissions, configuration, plugins, etc.)
│
└── Custom CRM Plugin
    └── Azure SQL
        └── CRM business data
            (customers, appointments, employees, services, etc.)
```

- **Neon PostgreSQL** — NocoBase internal/system database
- **Azure SQL** — Parlour CRM business data
- **Azure App Service** — Production application hosting
- **GitHub Actions** — CI/CD deployment

---

## Prerequisites

Install the following before starting:

- Git
- Node.js **22**
- Yarn Classic **1.22.22**

Check your versions:

```bash
node --version
yarn --version
git --version
```

Install Yarn Classic if needed:

```bash
npm install --global yarn@1.22.22
```

---

# Quick Start

## 1. Clone the Repository

Clone the project:

```bash
git clone https://github.com/Pradeeppk7/parlour_chicago.git
cd parlour_chicago
```

Switch to the development branch:

```bash
git checkout develop
git pull origin develop
```

For new work, create your own feature branch:

```bash
git checkout -b feature/your-feature-name
```

Example:

```bash
git checkout -b feature/customer-search
```

---

## 2. Create the Environment File

Create a file named:

```text
.env
```

in the project root.

> **Never commit `.env` to GitHub.**
>
> Ask the project owner/team for the development database credentials.

Use the following structure:

```dotenv
# --------------------------------------------------
# Application
# --------------------------------------------------

APP_ENV=development
APP_KEY=<your-app-key>
APP_PORT=13000
API_BASE_PATH=/api/

# --------------------------------------------------
# NocoBase Database - Neon PostgreSQL
# --------------------------------------------------

DB_DIALECT=postgres
DB_HOST=<neon-host>
DB_PORT=5432
DB_DATABASE=nocobase
DB_USER=<neon-user>
DB_PASSWORD=<neon-password>

DB_DIALECT_OPTIONS_SSL_REJECT_UNAUTHORIZED=false
DB_LOGGING=off

# --------------------------------------------------
# CRM Business Database - Azure SQL
# --------------------------------------------------

AZURE_SQL_SERVER=<azure-sql-server>.database.windows.net
AZURE_SQL_DATABASE=<database-name>
AZURE_SQL_USER=<username>
AZURE_SQL_PASSWORD=<password>
AZURE_SQL_PORT=1433
```

### Generate an APP_KEY

Generate a random application key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the generated value into:

```dotenv
APP_KEY=<generated-value>
```

Do not share or commit the key.

---

## 3. Install Dependencies

Run:

```bash
yarn install --frozen-lockfile
```

On Windows, if PowerShell prevents `yarn` from running, use:

```bash
yarn.cmd install --frozen-lockfile
```

---

## 4. Start the Application

Run:

```bash
yarn dev
```

On Windows, if necessary:

```bash
yarn.cmd dev
```

Open:

```text
http://localhost:13000
```

Sign in using the team's NocoBase development account.

---

## 5. Check the CRM Plugin

The custom plugin is:

```text
@parlour/plugin-crm
```

If it is not enabled:

1. Open NocoBase
2. Go to **Plugin Manager**
3. Find `@parlour/plugin-crm`
4. Enable the plugin

The plugin contains:

```text
packages/plugins/@parlour/plugin-crm/
├── src/
│   ├── client/
│   ├── client-v2/
│   └── server/
```

The server side communicates with **Azure SQL**, while the client communicates with the NocoBase server API.

```text
Browser / React
      ↓
NocoBase API
      ↓
CRM Server Plugin
      ↓
Azure SQL
```

Do not connect Azure SQL directly from browser/client code.

---

# Database Initialization

Normally, team members **do not need to initialize the database** because the development Neon database already contains the NocoBase installation.

Simply configure `.env` and run:

```bash
yarn dev
```

Only when creating a completely new NocoBase database should you run:

```bash
yarn nocobase install
```

Do not run this against a database unless you intend to initialize it.

---

# Git Workflow

The project uses the following branch workflow:

```text
feature branch
      ↓
   develop
      ↓
     main
      ↓
GitHub Actions
      ↓
Azure App Service
```

## Starting New Work

Always update `develop` first:

```bash
git checkout develop
git pull origin develop
```

Create a feature branch:

```bash
git checkout -b feature/your-feature-name
```

Make your changes.

Then:

```bash
git add .
git commit -m "Describe your change"
git push -u origin feature/your-feature-name
```

Create a Pull Request:

```text
feature/your-feature-name → develop
```

After development/testing is complete, changes are merged:

```text
develop → main
```

`main` is the production branch and triggers the Azure deployment workflow.

**Do not push directly to `main`.**

---

# Common Commands

| Command | Purpose |
| --- | --- |
| `yarn dev` | Start local development server |
| `yarn start` | Start the production-built application |
| `yarn build` | Build the application |
| `yarn test` | Run tests |
| `yarn e2e` | Run end-to-end tests |
| `yarn lint` | Run ESLint |
| `yarn clean` | Remove generated build output |
| `yarn pm` | NocoBase plugin manager CLI |

---

# Production Build

To test a production build locally:

```bash
yarn install --frozen-lockfile
yarn build
yarn start
```

Production uses environment variables configured in **Azure App Service** rather than committing a `.env` file.

Production settings include:

```text
APP_ENV=production

Neon PostgreSQL credentials
Azure SQL credentials
APP_KEY
```

Never commit production credentials to the repository.

---

# Azure Deployment

Production is hosted using:

```text
GitHub main branch
        ↓
GitHub Actions
        ↓
Azure App Service
        ↓
NocoBase
        ↓
Neon PostgreSQL + Azure SQL
```

The GitHub Actions workflow is located in:

```text
.github/workflows/
```

A merge into `main` triggers the production deployment.

The Azure App Service startup command is:

```bash
yarn start
```

---

# Project Structure

```text
parlour_chicago/
│
├── .github/
│   └── workflows/
│       └── Azure deployment workflow
│
├── packages/
│   └── plugins/
│       └── @parlour/
│           └── plugin-crm/
│               ├── src/
│               │   ├── client/
│               │   ├── client-v2/
│               │   └── server/
│               └── package.json
│
├── storage/
│
├── .env
├── .yarnrc
├── package.json
├── yarn.lock
└── README.md
```

---

# Troubleshooting

## `yarn.ps1` Cannot Be Loaded on Windows

Use:

```bash
yarn.cmd dev
```

or:

```bash
yarn.cmd install --frozen-lockfile
```

Alternatively, configure PowerShell to allow locally signed scripts.

---

## Port 13000 Is Already in Use

Change:

```dotenv
APP_PORT=13000
```

to another available port, for example:

```dotenv
APP_PORT=13001
```

Then open:

```text
http://localhost:13001
```

---

## NocoBase Cannot Connect to Neon

Check:

```text
DB_HOST
DB_PORT
DB_DATABASE
DB_USER
DB_PASSWORD
```

Also ensure:

```dotenv
DB_DIALECT=postgres
DB_DIALECT_OPTIONS_SSL_REJECT_UNAUTHORIZED=false
```

---

## CRM Cannot Connect to Azure SQL

Check:

```text
AZURE_SQL_SERVER
AZURE_SQL_DATABASE
AZURE_SQL_USER
AZURE_SQL_PASSWORD
AZURE_SQL_PORT
```

Also verify that Azure SQL firewall/network settings allow the connection.

Never post database passwords in GitHub issues, Pull Requests, screenshots, or chat messages.

---

## Dependencies Are Not Working Correctly

Verify:

```bash
node --version
yarn --version
```

The recommended environment is:

```text
Node.js 22
Yarn 1.22.22
```

Then try:

```bash
yarn clean
yarn install --frozen-lockfile
```

---

# Security

Never commit any of the following:

```text
.env
database passwords
APP_KEY
Azure credentials
Neon credentials
API keys
access tokens
```

Use `.env` for local development and Azure App Service environment variables for production.

---

# Team Quick Reference

For an existing team member setting up the project on a new computer, the normal process is:

```bash
git clone https://github.com/Pradeeppk7/parlour_chicago.git
cd parlour_chicago

git checkout develop
git pull origin develop

# Create .env using team development credentials

yarn install --frozen-lockfile
yarn dev
```

Then open:

```text
http://localhost:13000
```

For new development:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

Make changes, commit them, push the feature branch, and create a Pull Request into `develop`.