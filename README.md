<p align="center">
  <img src="./public/aura_big_logo.png" alt="Aura Cloud Logo" width="600" />
</p>

# Aura Cloud

### Cloud diagnostics for developers — with AI access through MCP

Aura Cloud is a cloud diagnostics platform designed to help developers determine whether an application failure originates in their code or in the underlying cloud environment.

The platform collects AWS configuration and permission data, evaluates infrastructure state, and exposes diagnostics through both a web dashboard and a Model Context Protocol (MCP) server.

Aura Cloud was developed as a B.Sc. Computer Science final project at The Academic College of Tel Aviv-Yaffo.

---

## Project Status

The academic project was completed in **September 2026**.

The AWS environment originally used for development and demonstration is no longer intended to remain permanently hosted due to ongoing cloud infrastructure costs.

As a result, this repository should primarily be viewed as the source code and technical documentation of the project. Running the complete system requires configuring your own AWS environment and the supporting services described below.

The architecture, source code, screenshots, and MCP implementation remain available for technical review.

---

## The Problem

Modern applications often depend on cloud permissions and infrastructure that are invisible to application developers.

When an application suddenly fails to access an S3 bucket, publish to SQS, or perform another AWS operation, the failure may originate from:

- application code
- IAM permissions
- organization-level policies
- resource configuration
- infrastructure changes

Without visibility into the cloud layer, developers may spend significant time debugging application code when the actual problem is an infrastructure permission or configuration issue.

Aura Cloud provides a centralized view of cloud state and permission diagnostics so developers can identify these failures earlier and escalate them with useful context.

---

## Architecture

Aura Cloud uses a modular architecture that separates cloud data collection, permission evaluation, persistence, APIs, user interfaces, and AI integrations.

<p align="center">
  <img src="./public/aura_hld.jpg" alt="Aura Cloud Architecture" width="850" />
</p>

### High-Level Data Flow

```text
                  AWS
                   │
                   ▼
              Crawlers
                   │
                   ▼
                 Redis
                   │
                   ▼
          Permission / Logic
             Evaluation
                   │
                   ▼
                MongoDB
               /       \
              /         \
             ▼           ▼
        API Server    MCP Server
             │           │
             ▼           ▼
        React UI     AI Clients
```

### Main Components

**AWS Crawlers**

Background workers collect configuration and permission information from AWS services and synchronize cloud state into Redis.

The crawler layer is designed to handle AWS API constraints such as throttling and different polling requirements between services.

**Redis**

Used as the fast-access storage layer for cloud configuration and permission data collected by the crawlers.

Cloud permissions form interconnected relationships between users, groups, policies, resources, and actions. Redis provides an efficient representation for data that is read and updated frequently during evaluation.

**Logic Server**

Evaluates collected cloud configuration and permission data to determine the effective state of monitored resources and actions.

The evaluation layer is separated from the crawlers and API so cloud ingestion, permission analysis, and client requests can evolve independently.

**MongoDB**

Stores persistent application state such as monitored resources, watchlists, user-related data, and evaluation results.

**API Server**

A Node.js / Express service exposing platform functionality to the web application and handling application-level authentication and data access.

**Frontend**

A React application that presents cloud health, monitored resources, permission states, and diagnostics to developers.

---

## MCP Integration

Aura Cloud includes a **Model Context Protocol (MCP) server** that exposes cloud diagnostics directly to AI clients.

Instead of requiring an AI assistant to understand the internal storage model or manually inspect AWS configuration, the MCP server exposes structured tools that allow the client to query Aura Cloud.

Example capabilities include:

- retrieving permission status for monitored resources
- listing AWS resources
- inspecting available actions for resources
- reading and managing monitored resources
- evaluating theoretical AWS permissions

### Theoretical Permission Evaluation

One of the MCP capabilities allows an AI client to ask whether a specific AWS action would be permitted for a resource even when that exact operation has not already been added to the user's watchlist.

Conceptually:

```text
Developer / AI Client
        │
        │ "Can this identity perform
        │  sqs:SendMessage on this queue?"
        ▼
    MCP Server
        │
        ▼
 Permission Evaluation
        │
        ├── Redis → AWS permission/configuration state
        │
        └── MongoDB → application/context data
        │
        ▼
 Structured Permission Result
```

This enables AI-assisted cloud debugging using the same infrastructure information available to Aura Cloud itself.

### Why the MCP Server Accesses Redis and MongoDB

The platform's API did not expose every piece of data required by the MCP tools.

Routing all MCP functionality through the existing API would therefore have required substantially expanding the API solely to support the MCP layer.

For relevant operations, the MCP server instead integrates directly with Redis and MongoDB.

This keeps the MCP implementation focused on translating platform state into AI-accessible tools while avoiding an unnecessary intermediate API layer.

---

## Example Scenario

Consider an application that attempts to publish a message to an AWS SQS queue.

The application fails even though the application logic itself is correct.

Aura Cloud's crawlers detect the relevant AWS permission state and the evaluation layer can identify that the operation is blocked, for example:

```text
sqs:SendMessage
→ DENIED
→ No matching Allow statement found in identity policies
```

Instead of treating the failure only as an application bug, the developer can immediately investigate the relevant AWS permission or provide the diagnostic information to the infrastructure team.

The same information can also be queried through the MCP server by an AI development assistant.

---

## Dashboard

<p align="center">
  <img
    src="./public/Screenshot%202026-05-30%20at%2020.26.58.png"
    alt="Aura Cloud Dashboard"
    width="850"
  />
</p>

The dashboard provides a developer-oriented view of monitored cloud resources and their current diagnostic state.

---

## Tech Stack

| Area | Technologies |
|---|---|
| Language | TypeScript |
| Backend | Node.js, Express |
| Frontend | React, Vite, Material UI, React Query |
| Cloud | AWS |
| Cloud Security | IAM, AWS permissions and policies |
| Fast State / Cache | Redis |
| Persistent Storage | MongoDB |
| AI Integration | Model Context Protocol (MCP) |
| Authentication | JWT / OAuth-based flows |
| Testing | Vitest |

---

## Repository Structure

```text
AuraCloud/
├── api-server/       # Application API
├── crawlers/         # AWS configuration and permission collection
├── logic/            # Permission and cloud-state evaluation
├── mcp-server/       # MCP tools for AI clients
├── src/              # Frontend application
├── shared/           # Shared types and utilities
├── public/           # Images and project assets
└── README.md
```

The components are kept separate so collection, evaluation, API access, UI presentation, and AI integrations can be developed independently.

---

## My Contributions — Amit Reich

As part of the team that developed Aura Cloud, my primary focus was the **AWS/cloud layer, system architecture, and MCP integration**.

My contributions included:

- **AWS & IAM:** Studied and implemented the AWS permission model used by the project, including IAM identities, policies, actions, and permission relationships required by the diagnostic engine.
- **Architecture:** Participated extensively in designing the system architecture and the interaction between cloud crawlers, Redis, MongoDB, the evaluation layer, APIs, and MCP.
- **Cloud Crawlers:** Implemented crawler-related logic, including synchronization of AWS user/identity information into Redis for downstream permission evaluation.
- **MCP Server:** Contributed to the MCP implementation and added tools/routes for exposing cloud diagnostics to AI clients.
- **Theoretical Permission Evaluation:** Implemented functionality that allows the MCP layer to evaluate hypothetical AWS resource/action permissions.
- **MCP Data Integration:** Integrated the MCP server directly with Redis and MongoDB where the existing application API did not expose the data required by the MCP tools.

The MCP server was developed collaboratively and evolved across multiple contributors. My work focused on the functionality and data integrations described above; the MCP authentication layer was implemented by other members of the team.

---

## Running the Project

Aura Cloud consists of multiple services and requires external infrastructure to reproduce the complete environment.

A full deployment requires, at minimum:

- an AWS account configured for Aura Cloud's crawlers
- AWS credentials and appropriate read permissions
- Redis
- MongoDB
- Node.js
- configuration/environment variables for the relevant services

Individual components contain their own configuration and package definitions.

> **Note:** The original AWS environment used during development of the academic project is not maintained as a permanent public deployment. You will need to provide your own AWS environment and credentials to run the complete system.

---

## Academic Project

Aura Cloud was developed as a **B.Sc. Computer Science final project** at  
**The Academic College of Tel Aviv-Yaffo (MTA)**.

Project completed: **September 2026**.

The project explored cloud observability, AWS permission analysis, distributed service architecture, and the use of MCP to make infrastructure diagnostics accessible to AI development tools.

---

## Disclaimer

Aura Cloud is an academic engineering project and is not an actively hosted commercial cloud-monitoring service.

The repository is maintained as a technical demonstration of the system's architecture and implementation.
