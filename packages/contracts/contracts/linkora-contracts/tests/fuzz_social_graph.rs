#![cfg(test)]

use linkora_contracts::{LinkoraContract, LinkoraContractClient};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

// Property-based tests for social graph integrity
// These tests verify that the follow/unfollow/block invariants hold
// under arbitrary sequences of operations.

fn setup_contract() -> (Env, LinkoraContractClient) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, LinkoraContract);
    let client = LinkoraContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &500, &17_280);

    (env, client)
}

proptest! {
    #[test]
    fn test_fuzz_follow_unfollow_consistency(
        ops in prop::collection::vec(any::<bool>(), 0..20)
    ) {
        let (env, client) = setup_contract();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        // Set profiles
        client.set_profile(&alice, &"alice".try_into().unwrap(), &"Alice".try_into().unwrap(), &"".try_into().unwrap());
        client.set_profile(&bob, &"bob".try_into().unwrap(), &"Bob".try_into().unwrap(), &"".try_into().unwrap());

        let mut expected_following = false;

        for &should_follow in &ops {
            if should_follow {
                // Follow
                client.follow(&alice, &bob);
                expected_following = true;
            } else {
                // Unfollow
                client.unfollow(&alice, &bob);
                expected_following = false;
            }
        }

        // Verify final state matches expected
        let followers = client.get_followers(&bob, &0, &50);
        let is_following = followers.contains(&alice);

        assert_eq!(is_following, expected_following,
            "Follow state mismatch: expected {}, got {}", expected_following, is_following);
    }

    #[test]
    fn test_fuzz_block_unblock_consistency(
        ops in prop::collection::vec(any::<bool>(), 0..20)
    ) {
        let (env, client) = setup_contract();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        // Set profiles
        client.set_profile(&alice, &"alice".try_into().unwrap(), &"Alice".try_into().unwrap(), &"".try_into().unwrap());
        client.set_profile(&bob, &"bob".try_into().unwrap(), &"Bob".try_into().unwrap(), &"".try_into().unwrap());

        // Follow first
        client.follow(&alice, &bob);

        let mut expected_blocked = false;

        for &should_block in &ops {
            if should_block {
                // Block
                client.block(&alice, &bob);
                expected_blocked = true;
            } else {
                // Unblock
                client.unblock(&alice, &bob);
                expected_blocked = false;
            }
        }

        // If blocked, follow should have been removed
        let followers = client.get_followers(&bob, &0, &50);
        let is_following = followers.contains(&alice);

        if expected_blocked {
            assert!(!is_following, "Block should remove follow relationship");
        }
    }

    #[test]
    fn test_fuzz_follow_count_accuracy(
        num_followers in 1usize..15,
    ) {
        let (env, client) = setup_contract();
        let target = Address::generate(&env);

        client.set_profile(&target, &"target".try_into().unwrap(), &"Target".try_into().unwrap(), &"".try_into().unwrap());

        let mut followers = Vec::new();

        // Create followers
        for i in 0..num_followers {
            let follower = Address::generate(&env);
            let username = format!("user{}", i);
            client.set_profile(&follower, &username.try_into().unwrap(), &username.try_into().unwrap(), &"".try_into().unwrap());
            client.follow(&follower, &target);
            followers.push(follower);
        }

        // Verify count
        let retrieved_followers = client.get_followers(&target, &0, &50);
        assert_eq!(retrieved_followers.len(), num_followers as u32,
            "Follower count mismatch: expected {}, got {}", num_followers, retrieved_followers.len());

        // Verify all followers are present
        for follower in &followers {
            assert!(retrieved_followers.contains(follower),
                "Follower not found in list");
        }
    }

    #[test]
    fn test_fuzz_block_removes_follows(
        num_initial_follows in 1usize..10,
        block_index in 0usize..10,
    ) {
        prop_assume!(block_index < num_initial_follows);

        let (env, client) = setup_contract();
        let blocker = Address::generate(&env);

        client.set_profile(&blocker, &"blocker".try_into().unwrap(), &"Blocker".try_into().unwrap(), &"".try_into().unwrap());

        let mut users = Vec::new();

        // Create mutual follows
        for i in 0..num_initial_follows {
            let user = Address::generate(&env);
            let username = format!("user{}", i);
            client.set_profile(&user, &username.try_into().unwrap(), &username.try_into().unwrap(), &"".try_into().unwrap());

            // Mutual follow
            client.follow(&blocker, &user);
            client.follow(&user, &blocker);

            users.push(user);
        }

        // Block one user
        let blocked_user = &users[block_index];
        client.block(&blocker, blocked_user);

        // Verify the block removed both follow directions
        let blocker_following = client.get_following(&blocker, &0, &50);
        assert!(!blocker_following.contains(blocked_user),
            "Blocker should not be following blocked user");

        let blocker_followers = client.get_followers(&blocker, &0, &50);
        assert!(!blocker_followers.contains(blocked_user),
            "Blocked user should not be in blocker's followers");

        // Verify other follows remain intact
        for (i, user) in users.iter().enumerate() {
            if i != block_index {
                assert!(blocker_following.contains(user),
                    "Non-blocked user should still be followed");
            }
        }
    }
}
