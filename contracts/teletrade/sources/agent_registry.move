module teletrade::agent_registry {
    use std::signer;
    use aptos_framework::event;

    const MODE_MANUAL: u8 = 0;
    const MODE_AUTO: u8 = 1;

    struct Agent has key {
        pubkey: vector<u8>,
        max_leverage: u64,
        metadata: vector<u8>,
    }

    struct UserConfig has key {
        agent: address,
        leverage: u64,
        mode: u8, // 0 = manual, 1 = auto
    }

    #[event]
    struct AgentRegistered has drop, store { agent: address, max_leverage: u64 }
    #[event]
    struct UserLinked      has drop, store { user: address, agent: address }
    #[event]
    struct LeverageUpdated has drop, store { user: address, leverage: u64 }
    #[event]
    struct ModeUpdated     has drop, store { user: address, mode: u8 }

    public entry fun register_agent(
        account: &signer,
        pubkey: vector<u8>,
        max_leverage: u64,
        metadata: vector<u8>
    ) {
        let addr = signer::address_of(account);
        assert!(!exists<Agent>(addr), 100);
        move_to<Agent>(account, Agent { pubkey, max_leverage, metadata });
        event::emit<AgentRegistered>(AgentRegistered { agent: addr, max_leverage });
    }

    public entry fun link_user(account: &signer, agent_addr: address)
    acquires UserConfig {
        let user = signer::address_of(account);
        assert!(exists<Agent>(agent_addr), 101);
        if (!exists<UserConfig>(user)) {
            move_to<UserConfig>(account, UserConfig { agent: agent_addr, leverage: 1, mode: MODE_MANUAL });
        } else {
            let c = borrow_global_mut<UserConfig>(user);
            c.agent = agent_addr;
        };
        event::emit<UserLinked>(UserLinked { user, agent: agent_addr });
    }

    public entry fun set_user_leverage(account: &signer, leverage: u64)
    acquires UserConfig, Agent {
        let user = signer::address_of(account);
        if (!exists<UserConfig>(user)) {
            move_to<UserConfig>(account, UserConfig { agent: @0x0, leverage, mode: MODE_MANUAL });
        } else {
            let c = borrow_global_mut<UserConfig>(user);
            if (exists<Agent>(c.agent)) {
                let a = borrow_global<Agent>(c.agent);
                assert!(leverage <= a.max_leverage, 103);
            };
            c.leverage = leverage;
        };
        event::emit<LeverageUpdated>(LeverageUpdated { user, leverage });
    }

    public entry fun set_user_mode(account: &signer, mode: u8)
    acquires UserConfig {
        let user = signer::address_of(account);
        assert!(mode == MODE_MANUAL || mode == MODE_AUTO, 104);
        if (!exists<UserConfig>(user)) {
            move_to<UserConfig>(account, UserConfig { agent: @0x0, leverage: 1, mode });
        } else {
            let c = borrow_global_mut<UserConfig>(user);
            c.mode = mode;
        };
        event::emit<ModeUpdated>(ModeUpdated { user, mode });
    }

    public fun get_user_config(user: address): (address, u64, u8)
    acquires UserConfig {
        let c = borrow_global<UserConfig>(user);
        (c.agent, c.leverage, c.mode)
    }

    public fun is_agent(addr: address): bool {
        exists<Agent>(addr)
    }
}

