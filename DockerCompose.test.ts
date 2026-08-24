interface ComposeVolumeMount {
    type?: string;
    source?: string;
    target?: string;
}

interface ComposeService {
    volumes?: ComposeVolumeMount[];
}

interface ComposeConfig {
    services?: Record<string, ComposeService>;
    volumes?: Record<string, unknown>;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

Deno.test("bridge persists Deno localStorage in a named volume", async () => {
    const command = new Deno.Command("docker", {
        args: ["compose", "-f", "docker-compose.yml", "config", "--format", "json"],
        stdout: "piped",
        stderr: "piped",
    });
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr).trim();

    assert(
        output.success,
        `docker compose config failed${stderr ? `: ${stderr}` : ""}`,
    );

    const config = JSON.parse(stdout) as ComposeConfig;
    const bridge = config.services?.bridge;
    assert(bridge, "bridge service must be present in the Compose configuration");
    assert(
        Array.isArray(bridge.volumes),
        "bridge service must define volumes",
    );

    const localStorageMount = bridge.volumes.find((mount) =>
        mount.type === "volume" && mount.target === "/deno-dir/location_data"
    );
    assert(
        localStorageMount,
        "bridge service must mount a volume at /deno-dir/location_data",
    );
    assert(
        localStorageMount.source,
        "the /deno-dir/location_data volume mount must have a source",
    );
    assert(
        config.volumes && Object.prototype.hasOwnProperty.call(
            config.volumes,
            localStorageMount.source,
        ),
        `volume ${localStorageMount.source} must be declared at the top level`,
    );
});

Deno.test("bridge image prepares the localStorage volume for the deno user", async () => {
    const dockerfile = await Deno.readTextFile("Dockerfile");
    const nonRootUser = dockerfile.indexOf("\nUSER deno");
    assert(nonRootUser !== -1, "Dockerfile must switch to the deno user");

    const preparation = dockerfile.slice(0, nonRootUser);
    const instruction = preparation.split("\n").find((line) =>
        line.startsWith("RUN") && line.includes("/deno-dir/location_data")
    );
    assert(
        instruction,
        "Dockerfile must prepare /deno-dir/location_data before switching to the deno user",
    );
    assert(
        instruction.includes("mkdir") &&
            instruction.includes("chown") &&
            instruction.includes("deno:deno"),
        "/deno-dir/location_data must be created with ownership for the deno user",
    );
});
