# 🐳 Docker Deployment Guide

Complete guide for containerizing and deploying the Inventory Management System with Docker.

---

## 📋 Table of Contents

1. [Docker Setup](#docker-setup)
2. [Docker Compose Development](#docker-compose-development)
3. [Production Docker Build](#production-docker-build)
4. [Container Orchestration](#container-orchestration)
   - [Docker Swarm](#docker-swarm)
   - [Kubernetes](#kubernetes)
   - [AWS ECS](#aws-ecs)
5. [Best Practices](#best-practices)

---

## Docker Setup

### Dockerfile

Create `Dockerfile` in `Project-root/`:

```dockerfile
# Multi-stage build for optimized image size
FROM python:3.11-slim as builder

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    postgresql-client \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --user --no-cache-dir -r requirements.txt

# Final stage
FROM python:3.11-slim

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Copy Python dependencies from builder
COPY --from=builder /root/.local /root/.local

# Copy application code
COPY . .

# Set Python path
ENV PATH=/root/.local/bin:$PATH

# Create non-root user
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:5000/health', timeout=5)"

# Run gunicorn
CMD ["gunicorn", "wsgi:app", "--bind", "0.0.0.0:5000", "--workers", "4", "--threads", "2", "--timeout", "120"]
```

### .dockerignore

Create `.dockerignore`:

```
__pycache__
*.pyc
*.pyo
*.pyd
.Python
env/
venv/
venv2/
.env
.env.local
*.log
.git
.gitignore
.pytest_cache
.coverage
htmlcov/
*.md
!README.md
tests/
migrations/*.sql
.vscode/
.idea/
```

---

## Docker Compose Development

### docker-compose.yml

Create `docker-compose.yml` for local development:

```yaml
version: '3.8'

services:
  # PostgreSQL Database
  db:
    image: postgres:15-alpine
    container_name: inventory-db
    environment:
      POSTGRES_USER: inventory_user
      POSTGRES_PASSWORD: inventory_pass
      POSTGRES_DB: inventory_db
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U inventory_user -d inventory_db"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis (optional - for rate limiting)
  redis:
    image: redis:7-alpine
    container_name: inventory-redis
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Flask Application
  web:
    build:
      context: ./Project-root
      dockerfile: Dockerfile
    container_name: inventory-web
    ports:
      - "5000:5000"
    environment:
      - FLASK_ENV=production
      - SECRET_KEY=${SECRET_KEY}
      - DATABASE_URL=postgresql://inventory_user:inventory_pass@db:5432/inventory_db
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - BASE_URL=http://localhost:5000
      - RATELIMIT_STORAGE_URL=redis://redis:6379
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - ./Project-root:/app
    command: gunicorn wsgi:app --bind 0.0.0.0:5000 --workers 2 --reload

  # Nginx (optional - reverse proxy)
  nginx:
    image: nginx:alpine
    container_name: inventory-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./Project-root/static:/usr/share/nginx/html/static:ro
    depends_on:
      - web

volumes:
  postgres_data:
```

### nginx.conf

Create `nginx.conf` for reverse proxy:

```nginx
events {
    worker_connections 1024;
}

http {
    upstream web {
        server web:5000;
    }

    server {
        listen 80;
        server_name localhost;

        # Security headers
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        # Static files
        location /static {
            alias /usr/share/nginx/html/static;
            expires 30d;
            add_header Cache-Control "public, immutable";
        }

        # Proxy to Flask app
        location / {
            proxy_pass http://web;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_redirect off;
            
            # Timeouts
            proxy_connect_timeout 60s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
        }

        # Health check endpoint
        location /health {
            proxy_pass http://web/health;
            access_log off;
        }
    }
}
```

### Running with Docker Compose

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f web

# Stop services
docker-compose down

# Rebuild after code changes
docker-compose up -d --build
```

---

## Production Docker Build

### Build Production Image

```bash
cd Project-root
docker build -t inventory-system:latest .
```

### Optimize Image Size

**Multi-stage build tips:**
- Use `python:3.11-slim` instead of full Python image
- Remove build dependencies in final stage
- Use `.dockerignore` to exclude unnecessary files
- Leverage Docker layer caching

**Check image size:**
```bash
docker images inventory-system
```

### Push to Registry

**Docker Hub:**
```bash
docker tag inventory-system:latest yourusername/inventory-system:latest
docker push yourusername/inventory-system:latest
```

**AWS ECR:**
```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com
docker tag inventory-system:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/inventory-system:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/inventory-system:latest
```

**Google Container Registry:**
```bash
docker tag inventory-system:latest gcr.io/your-project-id/inventory-system:latest
docker push gcr.io/your-project-id/inventory-system:latest
```

---

## Container Orchestration

### Docker Swarm

#### Initialize Swarm

```bash
docker swarm init
```

#### Create Stack File

`docker-stack.yml`:

```yaml
version: '3.8'

services:
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: inventory_user
      POSTGRES_PASSWORD: inventory_pass
      POSTGRES_DB: inventory_db
    volumes:
      - postgres_data:/var/lib/postgresql/data
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
    networks:
      - inventory-network

  web:
    image: inventory-system:latest
    environment:
      - DATABASE_URL=postgresql://inventory_user:inventory_pass@db:5432/inventory_db
      - SECRET_KEY=${SECRET_KEY}
    ports:
      - "5000:5000"
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
      restart_policy:
        condition: on-failure
    networks:
      - inventory-network
    depends_on:
      - db

volumes:
  postgres_data:

networks:
  inventory-network:
    driver: overlay
```

#### Deploy Stack

```bash
docker stack deploy -c docker-stack.yml inventory
docker stack services inventory
docker stack ps inventory
```

---

### Kubernetes

#### Deployment Manifest

`k8s/deployment.yml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-web
  labels:
    app: inventory
spec:
  replicas: 3
  selector:
    matchLabels:
      app: inventory
  template:
    metadata:
      labels:
        app: inventory
    spec:
      containers:
      - name: web
        image: inventory-system:latest
        ports:
        - containerPort: 5000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: inventory-secrets
              key: database-url
        - name: SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: inventory-secrets
              key: secret-key
        - name: GOOGLE_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: inventory-secrets
              key: google-client-id
        - name: GOOGLE_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: inventory-secrets
              key: google-client-secret
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 5000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 5000
          initialDelaySeconds: 5
          periodSeconds: 5
```

#### Service Manifest

`k8s/service.yml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: inventory-service
spec:
  type: LoadBalancer
  selector:
    app: inventory
  ports:
  - protocol: TCP
    port: 80
    targetPort: 5000
```

#### Secrets

```bash
kubectl create secret generic inventory-secrets \
  --from-literal=database-url="postgresql://user:pass@host:5432/db" \
  --from-literal=secret-key="your-secret-key" \
  --from-literal=google-client-id="your-client-id" \
  --from-literal=google-client-secret="your-secret"
```

#### Deploy to Kubernetes

```bash
kubectl apply -f k8s/deployment.yml
kubectl apply -f k8s/service.yml
kubectl get pods
kubectl get services
```

#### Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: inventory-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: inventory-web
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

```bash
kubectl apply -f k8s/hpa.yml
kubectl get hpa
```

---

### AWS ECS

#### Task Definition

`ecs-task-definition.json`:

```json
{
  "family": "inventory-system",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "inventory-web",
      "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/inventory-system:latest",
      "portMappings": [
        {
          "containerPort": 5000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "FLASK_ENV",
          "value": "production"
        },
        {
          "name": "BASE_URL",
          "value": "https://inventory.example.com"
        }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:inventory/database-url"
        },
        {
          "name": "SECRET_KEY",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:inventory/secret-key"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/inventory-system",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:5000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 40
      }
    }
  ]
}
```

#### Create ECS Service

```bash
# Register task definition
aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json

# Create ECS cluster
aws ecs create-cluster --cluster-name inventory-cluster

# Create service
aws ecs create-service \
  --cluster inventory-cluster \
  --service-name inventory-service \
  --task-definition inventory-system \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-12345],securityGroups=[sg-12345],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/inventory-tg,containerName=inventory-web,containerPort=5000"
```

---

## Best Practices

### Security

1. **Run as non-root user**
   ```dockerfile
   RUN useradd -m -u 1000 appuser
   USER appuser
   ```

2. **Scan for vulnerabilities**
   ```bash
   docker scan inventory-system:latest
   ```

3. **Use secrets management**
   - Never hardcode secrets in Dockerfile
   - Use Docker secrets, Kubernetes secrets, or AWS Secrets Manager
   - Rotate secrets regularly

4. **Limit container capabilities**
   ```yaml
   security_opt:
     - no-new-privileges:true
   cap_drop:
     - ALL
   ```

### Performance

1. **Layer caching**: Order Dockerfile commands from least to most frequently changed
2. **Multi-stage builds**: Separate build and runtime dependencies
3. **Image size**: Use Alpine or slim base images
4. **Resource limits**: Set CPU and memory limits in production

### Monitoring

1. **Health checks**: Implement `/health` endpoint for container orchestration
2. **Logging**: Use structured logging and centralized log aggregation
3. **Metrics**: Export Prometheus metrics for monitoring
4. **Tracing**: Implement distributed tracing with Jaeger or Zipkin

### Backup & Recovery

1. **Database backups**: Schedule regular PostgreSQL backups
   ```bash
   docker exec inventory-db pg_dump -U inventory_user inventory_db > backup.sql
   ```

2. **Volume backups**: Back up Docker volumes
   ```bash
   docker run --rm -v postgres_data:/data -v $(pwd):/backup alpine tar czf /backup/postgres_backup.tar.gz /data
   ```

3. **Disaster recovery**: Document and test recovery procedures

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker logs inventory-web

# Inspect container
docker inspect inventory-web

# Check health status
docker ps --filter "name=inventory-web"
```

### Database Connection Issues

```bash
# Test database connectivity from web container
docker exec -it inventory-web psql $DATABASE_URL -c "SELECT 1"

# Check network connectivity
docker exec -it inventory-web ping db
```

### Performance Issues

```bash
# Monitor resource usage
docker stats inventory-web

# Check container processes
docker top inventory-web
```

---

## Additional Resources

- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [Kubernetes Documentation](https://kubernetes.io/docs/home/)
- [AWS ECS Guide](https://docs.aws.amazon.com/ecs/)
- [Docker Compose Reference](https://docs.docker.com/compose/compose-file/)

---

**Last Updated**: November 2025
**Version**: 1.0.0
