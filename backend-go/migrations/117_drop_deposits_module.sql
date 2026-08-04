-- Fixed Deposits now lives under the Finance module (not its own top-level pillar),
-- so the standalone 'deposits' module row from migration 116 is superseded. Remove it
-- so it doesn't linger as a dangling toggle in the admin module list.
DELETE FROM module_config WHERE key = 'deposits';
