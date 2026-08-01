import type { ReactNode } from 'react';

export function AdminDrawer(props: {
    open: boolean;
    title: string;
    eyebrow: string;
    onClose: () => void;
    children: ReactNode;
}) {
    return (
        <>
            <button
                className={'drawer-backdrop ' + (props.open ? 'visible' : '')}
                onClick={props.onClose}
                aria-label={'Close ' + props.title}
                tabIndex={props.open ? 0 : -1}
            />
            <aside className={'drawer admin-drawer ' + (props.open ? 'open' : '')} aria-hidden={!props.open} aria-modal='true' role='dialog'>
                {props.open && (
                    <>
                        <div className='drawer-head'>
                            <div><p className='eyebrow'>{props.eyebrow}</p><h2>{props.title}</h2></div>
                            <button className='close' onClick={props.onClose} aria-label='Close'>×</button>
                        </div>
                        {props.children}
                    </>
                )}
            </aside>
        </>
    );
}
