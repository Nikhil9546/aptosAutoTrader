module teletrade::signal_vault {
    use std::signer;
    use std::vector;
    use aptos_framework::event;
    use teletrade::agent_registry;

    struct EncryptedSignal has store {
        agent: address,
        user: address,
        hash: vector<u8>, // sha3-256(payload)
        blob: vector<u8>, // ciphertext
        iv: vector<u8>,   // 12-byte IV (AES-GCM)
        aad: vector<u8>,  // AAD bytes
        tag: vector<u8>,  // GCM tag
        ts: u64,
    }

    #[event]
    struct SignalPosted has drop, store {
        agent: address,
        user: address,
        hash: vector<u8>,
        ts: u64,
    }

    struct UserSignals has key {
        signals: vector<EncryptedSignal>,
    }

    /// Pass the hash twice: one stored, one used in the event.
    public entry fun post_signal(
        account: &signer,
        agent: address,
        hash_for_store: vector<u8>,
        hash_for_event: vector<u8>,
        blob: vector<u8>,
        iv: vector<u8>,
        aad: vector<u8>,
        tag: vector<u8>,
        ts: u64,
    ) acquires UserSignals {
        let user = signer::address_of(account);
        let (linked_agent, _lev, _mode) = agent_registry::get_user_config(user);
        assert!(linked_agent == agent, 200);

        if (!exists<UserSignals>(user)) {
            move_to<UserSignals>(account, UserSignals { signals: vector::empty<EncryptedSignal>() });
        };

        let sref = borrow_global_mut<UserSignals>(user);
        vector::push_back(&mut sref.signals, EncryptedSignal {
            agent, user,
            hash: hash_for_store,
            blob, iv, aad, tag, ts
        });

        event::emit<SignalPosted>(SignalPosted { agent, user, hash: hash_for_event, ts });
    }

    public fun count(user: address): u64 acquires UserSignals {
        if (!exists<UserSignals>(user)) { 0 } else {
            let s = borrow_global<UserSignals>(user);
            vector::length(&s.signals)
        }
    }
}

