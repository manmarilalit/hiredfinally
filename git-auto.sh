#!/bin/bash

# Get current branch name
current_branch=$(git branch --show-current)

# Check if on main/master
if [ "$current_branch" = "main" ] || [ "$current_branch" = "master" ]; then
    echo "Error: You're on $current_branch. Switch to a feature branch first."
    exit 1
fi

# Stage, commit, and push
git add .
git commit -m "update"
git push -u origin "$current_branch"

# Merge to main
git checkout main
git pull
git merge "$current_branch"
git push

# Clean up branches
git branch -d "$current_branch"
git push origin --delete "$current_branch"

echo "Done! Merged $current_branch into main and cleaned up."