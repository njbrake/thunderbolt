FROM postgres:18-alpine

COPY --chmod=755 deploy/docker/postgres-init/01-powersync.sh /docker-entrypoint-initdb.d/

EXPOSE 5432

# PowerSync replicates via logical decoding, so wal_level=logical is a hard
# requirement rather than a per-deployment preference. Baked in here so the
# image is correct on its own: orchestrators that cannot easily override the
# start command (Railway) work without extra wiring, and the ones that already
# pass it explicitly keep working, since args/command replace this CMD with an
# identical value. docker-compose.yml, deploy/k8s/templates/postgres.yaml, and
# deploy/pulumi/src/services.ts all still set it themselves.
CMD ["postgres", "-c", "wal_level=logical"]
