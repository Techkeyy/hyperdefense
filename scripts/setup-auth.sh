#!/bin/bash
mkdir -p hydra-auth
printf '%s\n' 'local-development-token-32-bytes' > hydra-auth/auth-token
echo "Auth token created at hydra-auth/auth-token"
