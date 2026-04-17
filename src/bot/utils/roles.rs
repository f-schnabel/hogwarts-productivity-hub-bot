use serenity::all::{Member, RoleId};

use crate::config::Config;
use crate::constants::{ROLE_OWNER, ROLE_PREFECT, ROLE_PROFESSOR};

/// Check if a member has any of the roles indicated by `role_mask`.
pub fn has_any_role(member: &Member, config: &Config, role_mask: u8) -> bool {
    let roles = &member.roles;

    let check = |flag: u8, role_id: u64| -> bool {
        role_mask & flag != 0 && roles.contains(&RoleId::new(role_id))
    };

    // OWNER is the bot owner by Discord ID, not a role
    if role_mask & ROLE_OWNER != 0 && member.user.id.get() == config.owner_id {
        return true;
    }

    check(ROLE_PREFECT, config.prefect_role_id)
        || check(ROLE_PROFESSOR, config.professor_role_id)
}

/// Returns the role ID to add for VC if needed, or None.
pub fn vc_role_needs_adding(member: &Member, config: &Config) -> Option<RoleId> {
    let vc_role = RoleId::new(config.vc_role_id);
    if member.roles.contains(&vc_role) {
        None
    } else {
        Some(vc_role)
    }
}

/// Returns the role ID to remove for VC if needed, or None.
pub fn vc_role_needs_removal(member: &Member, config: &Config) -> Option<RoleId> {
    let vc_role = RoleId::new(config.vc_role_id);
    if member.roles.contains(&vc_role) {
        Some(vc_role)
    } else {
        None
    }
}
