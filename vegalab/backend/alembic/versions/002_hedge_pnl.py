"""add pnl_attribution.hedge_pnl

The hedge leg's mark-to-market gets its own bucket; financing_pnl becomes
interest-only carry. Existing rows backfill to 0 (their hedge MTM stays in
financing_pnl — historical rows are not restated).

Revision ID: 002
Revises: 001
Create Date: 2026-06-10 12:50:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = '002'
down_revision = '001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'pnl_attribution',
        sa.Column('hedge_pnl', sa.Float(), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('pnl_attribution', 'hedge_pnl')
