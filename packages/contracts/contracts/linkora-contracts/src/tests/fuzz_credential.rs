#![cfg(test)]

use crate::test::*;
use soroban_sdk::{vec, BytesN, Env, Vec};

/// Fuzz tests for the credential subsystem
/// These tests use property-based testing to verify Merkle verification properties.
/// Note: Soroban doesn't have a native fuzzing framework, so these are
/// property-based tests that verify invariants across multiple test cases.

#[test]
fn test_fuzz_property_valid_proof_verifies() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env);

    // Property: For any valid (leaf, proof, root) triple, verification should succeed
    // Test with multiple different leaf values
    for i in 1..=10u8 {
        let leaf = BytesN::from_array(&env, &[i; 32]);
        let root = leaf.clone();
        let proof: Vec<BytesN<32>> = vec![&env];

        client.update_credential_root(&user, &root);

        let nullifier = BytesN::from_array(&env, &[i + 100; 32]);
        let result = client.verify_credential(&user, &leaf, &proof, &nullifier);

        assert!(result, "valid proof should verify for leaf value {}", i);
    }
}

#[test]
fn test_fuzz_property_wrong_leaf_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env);

    // Property: For any root, a proof with a different leaf should fail
    let root = BytesN::from_array(&env, &[1u8; 32]);
    client.update_credential_root(&user, &root);

    for i in 2..=10u8 {
        let wrong_leaf = BytesN::from_array(&env, &[i; 32]);
        let proof: Vec<BytesN<32>> = vec![&env];
        let nullifier = BytesN::from_array(&env, &[i + 100; 32]);

        let result = client.verify_credential(&user, &wrong_leaf, &proof, &nullifier);

        assert!(!result, "wrong leaf should fail for value {}", i);
    }
}

#[test]
fn test_fuzz_property_merkle_root_computation() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env);

    // Property: Merkle root computation is deterministic
    // For the same leaf and proof, the computed root should always be the same
    let leaf = BytesN::from_array(&env, &[1u8; 32]);
    let sibling = BytesN::from_array(&env, &[2u8; 32]);
    let proof = vec![&env, sibling.clone()];

    // Compute expected root using position-dependent hash
    let mut result = [0u8; 32];
    let leaf_arr = leaf.to_array();
    let sibling_arr = sibling.to_array();
    for i in 0..32 {
        result[i] = leaf_arr[i].wrapping_add(sibling_arr[i]).wrapping_add(0u8);
    }
    let expected_root = BytesN::from_array(&env, &result);

    client.update_credential_root(&user, &expected_root);

    // Verify multiple times - should always succeed
    for i in 1..=5u8 {
        let nullifier = BytesN::from_array(&env, &[i + 100; 32]);
        let result = client.verify_credential(&user, &leaf, &proof, &nullifier);
        assert!(
            result,
            "deterministic verification should succeed on iteration {}",
            i
        );
    }
}

#[test]
fn test_fuzz_property_nullifier_uniqueness_across_users() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    // Property: The same nullifier can be used by different users
    let user1 = <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env);
    let user2 = <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env);
    let user3 = <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env);

    let leaf = BytesN::from_array(&env, &[1u8; 32]);
    let root = leaf.clone();
    let proof: Vec<BytesN<32>> = vec![&env];
    let nullifier = BytesN::from_array(&env, &[10u8; 32]);

    client.update_credential_root(&user1, &root);
    client.update_credential_root(&user2, &root);
    client.update_credential_root(&user3, &root);

    // Same nullifier should work for all different users
    assert!(client.verify_credential(&user1, &leaf, &proof, &nullifier));
    assert!(client.verify_credential(&user2, &leaf, &proof, &nullifier));
    assert!(client.verify_credential(&user3, &leaf, &proof, &nullifier));
}

#[test]
fn test_fuzz_property_multiple_proofs_same_root() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_contract(&env);

    let user = <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env);

    // Property: Multiple different valid proofs can verify against the same root
    // (This would be the case with different leaves in the same Merkle tree)
    // For simplicity, we test that the same proof can be verified multiple times
    // with different nullifiers

    let leaf = BytesN::from_array(&env, &[1u8; 32]);
    let root = leaf.clone();
    let proof: Vec<BytesN<32>> = vec![&env];

    client.update_credential_root(&user, &root);

    // Verify the same proof multiple times with different nullifiers
    for i in 1..=10u8 {
        let nullifier = BytesN::from_array(&env, &[i; 32]);
        let result = client.verify_credential(&user, &leaf, &proof, &nullifier);
        assert!(
            result,
            "same proof should verify with different nullifier {}",
            i
        );
    }
}
